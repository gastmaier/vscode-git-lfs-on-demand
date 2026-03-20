import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { exec, execSync } from 'child_process';

const LFS_POINTER_PREFIX = Buffer.from('version https://git-lfs.github.com/spec/v1\noid sha256:');
const pulledFiles = new Set<string>();

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

function pullLfsFile(filePath: string, gitRoot: string): Promise<void> {
    const relPath = path.relative(gitRoot, filePath);
    if (pulledFiles.has(filePath)) {
        return Promise.resolve();
    }
    pulledFiles.add(filePath);

    return new Promise((resolve, reject) => {
        exec(`git lfs pull -I "${relPath}"`, { cwd: gitRoot }, (error) => {
            if (error) {
                pulledFiles.delete(filePath);
                reject(error);
            } else {
                resolve();
            }
        });
    });
}

function extractReferencedFiles(content: string, docPath: string): string[] {
    const dir = path.dirname(docPath);
    const files: string[] = [];

    const rstPatterns = [
        /\.\.\s+(?:image|figure)::\s*(.+)/g,
        /\.\.\s+include::\s*(.+)/g,
    ];

    const mdPatterns = [
        /!\[.*?\]\(([^)]+)\)/g,
        /<img[^>]+src=["']([^"']+)["']/g,
    ];

    const patterns = docPath.endsWith('.rst') ? rstPatterns : mdPatterns;

    for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(content)) !== null) {
            const ref = match[1].trim().split(/\s/)[0];
            if (ref && !ref.startsWith('http://') && !ref.startsWith('https://')) {
                const absPath = path.resolve(dir, ref);
                if (fs.existsSync(absPath)) {
                    files.push(absPath);
                }
            }
        }
    }

    return files;
}

async function handleDocument(document: vscode.TextDocument): Promise<void> {
    const filePath = document.uri.fsPath;
    const gitRoot = getGitRoot(filePath);
    if (!gitRoot) return;

    if (isLfsPointer(filePath)) {
        try {
            await pullLfsFile(filePath, gitRoot);
            vscode.commands.executeCommand('workbench.action.files.revert');
        } catch (e) {
            vscode.window.showErrorMessage(`Failed to pull LFS file: ${e}`);
        }
        return;
    }

    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.rst' || ext === '.md') {
        const content = document.getText();
        const refs = extractReferencedFiles(content, filePath);
        for (const ref of refs) {
            if (isLfsPointer(ref)) {
                try {
                    await pullLfsFile(ref, gitRoot);
                } catch (e) {
                    console.error(`Failed to pull LFS file ${ref}: ${e}`);
                }
            }
        }
    }
}

export function activate(context: vscode.ExtensionContext) {
    if (!isGitLfsInstalled()) {
        return;
    }

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (workspaceFolder && !isSkipSmudgeEnabled(workspaceFolder)) {
        return;
    }

    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument(handleDocument)
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('git-lfs-on-demand.pullFile', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) return;
            await handleDocument(editor.document);
        })
    );

    if (vscode.window.activeTextEditor) {
        handleDocument(vscode.window.activeTextEditor.document);
    }
}

export function deactivate() {}
