import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { exec, execSync } from 'child_process';

const LFS_POINTER_PREFIX = Buffer.from('version https://git-lfs.github.com/spec/v1\noid sha256:');
const pulledFiles = new Set<string>();
const pendingPulls = new Map<string, { gitRoot: string; resolve: () => void }>();
let output: vscode.OutputChannel;
let activeProgress: vscode.Progress<{ message?: string }> | null = null;
let progressResolve: (() => void) | null = null;

function updateProgress() {
    if (activeProgress && pendingPulls.size > 0) {
        activeProgress.report({
            message: `pulling ${pendingPulls.size} artifact${pendingPulls.size > 1 ? 's' : ''}`
        });
    }
}

function startProgressIfNeeded() {
    if (activeProgress || pendingPulls.size === 0) return;

    vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Git LFS: ',
        cancellable: false
    }, async (progress) => {
        activeProgress = progress;
        updateProgress();

        return new Promise<void>((resolve) => {
            progressResolve = resolve;
        });
    });
}

function finishProgressIfDone() {
    if (pendingPulls.size === 0 && progressResolve) {
        progressResolve();
        activeProgress = null;
        progressResolve = null;
    }
}

function isGitLfsInstalled(): boolean {
    try {
        execSync('git-lfs --version', { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

function isSkipSmudgeEnabled(cwd: string): boolean {
    if (process.env.GIT_LFS_SKIP_SMUDGE === '1') {
        return true;
    }
    try {
        const smudge = execSync('git config --get filter.lfs.smudge', { cwd, encoding: 'utf-8' }).trim();
        return smudge === 'git-lfs smudge --skip -- %f' || smudge === '';
    } catch {
        return true;
    }
}

function isLfsPointer(filePath: string): boolean {
    try {
        const fd = fs.openSync(filePath, 'r');
        const buffer = Buffer.alloc(LFS_POINTER_PREFIX.length);
        fs.readSync(fd, buffer, 0, LFS_POINTER_PREFIX.length, 0);
        fs.closeSync(fd);
        return buffer.equals(LFS_POINTER_PREFIX);
    } catch {
        return false;
    }
}

function getGitRoot(filePath: string): string | null {
    try {
        return execSync('git rev-parse --show-toplevel', {
            cwd: path.dirname(filePath),
            encoding: 'utf-8'
        }).trim();
    } catch {
        return null;
    }
}

function executePull(filePath: string, gitRoot: string): void {
    const relPath = path.relative(gitRoot, filePath);
    output.appendLine(`Pulling: ${relPath}`);

    exec(`git lfs pull -I "${relPath}"`, { cwd: gitRoot }, (error, _stdout, stderr) => {
        if (error) {
            pulledFiles.delete(filePath);
            output.appendLine(`Failed: ${relPath} - ${stderr || error.message}`);
        } else {
            output.appendLine(`Done: ${relPath}`);
        }

        const pending = pendingPulls.get(filePath);
        pendingPulls.delete(filePath);
        updateProgress();
        finishProgressIfDone();
        pending?.resolve();
    });
}

function pullLfsFile(filePath: string, gitRoot: string): Promise<void> {
    if (pulledFiles.has(filePath)) {
        return Promise.resolve();
    }
    pulledFiles.add(filePath);

    return new Promise<void>((resolve) => {
        pendingPulls.set(filePath, { gitRoot, resolve });
        startProgressIfNeeded();
        updateProgress();
        executePull(filePath, gitRoot);
    });
}

function extractReferencedFiles(content: string, docPath: string): string[] {
    const dir = path.dirname(docPath);
    const files = new Set<string>();

    const rstPatterns = [
        /\.\.\s+(?:image|figure)::\s*([^\n]+)/g,
        /:download:`(?:[^<`]*<)?([^>`]+)>?`/g,
    ];

    const mdPatterns = [
        /!\[.*?\]\(([^)]+)\)/g,
        /\[.*?\]\(([^)]+)\)/g,
        /<img[^>]+src=["']([^"']+)["']/g,
        /<a[^>]+href=["']([^"']+)["']/g,
    ];

    const patterns = docPath.endsWith('.rst') ? rstPatterns : mdPatterns;

    for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(content)) !== null) {
            const ref = match[1].trim().split(/\s/)[0];
            if (!ref || ref.startsWith('http://') || ref.startsWith('https://') || ref.startsWith('#')) {
                continue;
            }
            const absPath = path.resolve(dir, ref);
            if (fs.existsSync(absPath)) {
                files.add(absPath);
            }
        }
    }

    return Array.from(files);
}

function handleFile(filePath: string): void {
    if (!fs.existsSync(filePath)) return;

    const gitRoot = getGitRoot(filePath);
    if (!gitRoot) return;

    if (isLfsPointer(filePath)) {
        output.appendLine(`LFS pointer detected: ${path.basename(filePath)}`);
        pullLfsFile(filePath, gitRoot);
    }
}

function handleDocument(document: vscode.TextDocument): void {
    const filePath = document.uri.fsPath;
    const gitRoot = getGitRoot(filePath);
    if (!gitRoot) return;

    if (isLfsPointer(filePath)) {
        output.appendLine(`LFS pointer detected: ${path.basename(filePath)}`);
        pullLfsFile(filePath, gitRoot).then(() => {
            vscode.commands.executeCommand('workbench.action.files.revert');
        });
        return;
    }

    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.rst' || ext === '.md') {
        const content = document.getText();
        const refs = extractReferencedFiles(content, filePath);
        const lfsRefs = refs.filter(isLfsPointer);
        if (lfsRefs.length > 0) {
            output.appendLine(`Found ${lfsRefs.length} LFS reference(s) in ${path.basename(filePath)}`);
            lfsRefs.forEach((ref) => pullLfsFile(ref, gitRoot));
        }
    }
}

function handleTab(tab: vscode.Tab): void {
    if (tab.input instanceof vscode.TabInputText) {
        handleFile(tab.input.uri.fsPath);
    } else if (tab.input instanceof vscode.TabInputCustom) {
        handleFile(tab.input.uri.fsPath);
    }
}

export function activate(context: vscode.ExtensionContext) {
    output = vscode.window.createOutputChannel('Git LFS On-Demand');
    context.subscriptions.push(output);

    if (!isGitLfsInstalled()) {
        output.appendLine('Extension disabled, git-lfs not installed');
        return;
    }

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (workspaceFolder) {
        if (!isSkipSmudgeEnabled(workspaceFolder)) {
            output.appendLine('Extension disabled, git-lfs without skip-smudge');
            return;
        }
        output.appendLine('Extension enabled, git-lfs with skip-smudge');
    }

    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument(handleDocument)
    );

    context.subscriptions.push(
        vscode.window.tabGroups.onDidChangeTabs((e) => {
            for (const tab of e.opened) {
                handleTab(tab);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('git-lfs-on-demand.pull-file', () => {
            const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
            if (tab) {
                handleTab(tab);
            }
        })
    );

    for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
            handleTab(tab);
        }
    }
}

export function deactivate() {}
