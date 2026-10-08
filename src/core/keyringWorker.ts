import { AsyncEntry } from '@napi-rs/keyring';

type Request = { operation: 'get' | 'set' | 'delete'; server: string; value?: string };

async function main(): Promise<void> {
    let input = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) input += chunk;
    const request = JSON.parse(input) as Request;
    const entry = new AsyncEntry('GitLeaf', request.server, { linux: { store: 'keyutils' } });
    if (request.operation === 'get') {
        process.stdout.write(JSON.stringify({ value: await entry.getPassword() }));
    } else if (request.operation === 'set') {
        if (typeof request.value !== 'string') throw new Error('Missing credential value.');
        await entry.setPassword(request.value);
    } else if (request.operation === 'delete') {
        await entry.deleteCredential();
    } else {
        throw new Error('Invalid keyring operation.');
    }
}

void main().catch(error => {
    process.stderr.write(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
