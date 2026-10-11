import { spawn } from 'child_process';
import * as path from 'path';

type Operation = 'get' | 'set' | 'delete';

/** Run keyutils in its own session so a long-lived VS Code Server cannot pass
 * a revoked SSH session keyring to the extension host. */
export function linuxKeyring(operation: Operation, server: string, value?: string): Promise<string | undefined> {
    return new Promise((resolve, reject) => {
        const session = path.resolve(__dirname, '../../bin/keyring-session');
        const worker = path.join(__dirname, 'keyringWorker.js');
        const child = spawn(session, [process.execPath, worker], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        });
        let output = '', error = '', settled = false;
        const timer = setTimeout(() => {
            child.kill();
            finish(new Error('Linux credential store timed out.'));
        }, 30000);
        function finish(failure?: Error, result?: string): void {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (failure) reject(failure);
            else resolve(result);
        }
        child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
        child.stderr.setEncoding('utf8').on('data', chunk => { error += chunk; });
        child.on('error', failure => finish(failure));
        child.stdin.on('error', failure => finish(failure));
        child.on('close', code => {
            if (code !== 0) return finish(new Error(error.trim() || `Linux credential store exited with code ${code}.`));
            if (operation !== 'get') return finish();
            try {
                const result = JSON.parse(output) as { value: string | null };
                finish(undefined, result.value ?? undefined);
            } catch {
                finish(new Error('Invalid response from Linux credential store.'));
            }
        });
        child.stdin.end(JSON.stringify({ operation, server, value }));
    });
}
