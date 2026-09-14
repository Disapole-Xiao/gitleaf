import type { AsyncEntry } from '@napi-rs/keyring';
import { BaseAPI } from '../api/base';
export interface Identity {
    csrfToken: string;
    cookies: string;
}
export interface ServerCredential {
    serverUrl: string;
    userId: string;
    userEmail: string;
    userName: string;
    identity: Identity;
}
export interface CredentialStore {
    getCredential(server: string): Promise<ServerCredential | undefined>;
    storeCredential(credential: ServerCredential): Promise<void>;
    deleteCredential(server: string): Promise<void>;
}
export function serverUrl(value: string): string {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
        throw new Error('Use an http(s) server URL without credentials, query or fragment.');
    return url.toString().replace(/\/+$/, '');
}
/** Shared OS vault identity in Node and Electron. Never fall back to plaintext
 * or access VS Code's private credential storage. Locked keyrings fail closed. */
export class Credentials implements CredentialStore {
    private async entry(server: string): Promise<AsyncEntry> {
        const { AsyncEntry } = await import('@napi-rs/keyring');
        return new AsyncEntry('GitLeaf', serverUrl(server));
    }
    async getCredential(server: string): Promise<ServerCredential | undefined> {
        const value = await (await this.entry(server)).getPassword();
        if (!value) return;
        let data: ServerCredential;
        try {
            data = JSON.parse(value);
        } catch {
            throw new Error('Invalid GitLeaf credential. Log in again.');
        }
        if (data.serverUrl !== serverUrl(server) || !data.userId || !data.identity?.cookies || !data.identity.csrfToken)
            throw new Error('Invalid GitLeaf credential. Log in again.');
        // Older logins did not record the account name; present them as logged
        // out so the normal login UI can acquire a complete identity.
        if (!data.userName || !data.userEmail) return undefined;
        return data;
    }
    async storeCredential(data: ServerCredential): Promise<void> {
        await (
            await this.entry(data.serverUrl)
        ).setPassword(JSON.stringify({ ...data, serverUrl: serverUrl(data.serverUrl) }));
    }
    async deleteCredential(server: string): Promise<void> {
        await (await this.entry(server)).deleteCredential();
    }
    async hasCredential(server: string): Promise<boolean> {
        return !!(await this.getCredential(server));
    }
}
export async function projects(store: CredentialStore, server: string) {
    const credential = await store.getCredential(server);
    if (!credential) throw new Error('Log in to Overleaf first.');
    const result = await new BaseAPI(serverUrl(server)).setIdentity(credential.identity).getProjects();
    if (result.type !== 'success' || !result.projects)
        throw new Error('Cannot list Overleaf projects. Check your session and server access.');
    return result.projects.filter((project) => !project.archived && !project.trashed);
}
export async function login(
    store: CredentialStore,
    server: string,
    secret: { cookies: string } | { email: string; password: string },
) {
    const url = serverUrl(server),
        api = new BaseAPI(url);
    const result =
        'cookies' in secret
            ? await api.cookiesLogin(secret.cookies)
            : await api.passportLogin(secret.email, secret.password);
    if (result.type !== 'success' || !result.identity || !result.userInfo)
        throw new Error('Overleaf login failed. Check the supplied credentials.');
    await store.storeCredential({ serverUrl: url, ...result.userInfo, identity: result.identity });
    return { serverUrl: url, ...result.userInfo };
}
