import { Client } from '@heroiclabs/nakama-js';
import type { Session, Socket } from '@heroiclabs/nakama-js';

export type NakamaConnection = {
  client: Client;
  session: Session;
  socket: Socket;
};

const NAKAMA_HOST = import.meta.env.VITE_NAKAMA_HOST || '127.0.0.1';
const NAKAMA_PORT = String(import.meta.env.VITE_NAKAMA_PORT || 7350);
const NAKAMA_SERVER_KEY = import.meta.env.VITE_NAKAMA_SERVER_KEY || 'defaultkey';
const NAKAMA_USE_SSL = String(import.meta.env.VITE_NAKAMA_USE_SSL || 'false') === 'true';

function getOrCreateDeviceId(): string {
  const key = 'ttt.deviceId';
  try {
    const existing = sessionStorage.getItem(key);
    if (existing) return existing;
    const id = (crypto?.randomUUID ? crypto.randomUUID() : String(Date.now()) + '-' + Math.random().toString(16).slice(2));
    sessionStorage.setItem(key, id);
    return id;
  } catch {
    const existing = localStorage.getItem(key);
    if (existing) return existing;
    const id = (crypto?.randomUUID ? crypto.randomUUID() : String(Date.now()) + '-' + Math.random().toString(16).slice(2));
    localStorage.setItem(key, id);
    return id;
  }
}

export async function connectNakama(username: string): Promise<NakamaConnection> {
  const client = new Client(NAKAMA_SERVER_KEY, NAKAMA_HOST, NAKAMA_PORT, NAKAMA_USE_SSL);

  const deviceId = getOrCreateDeviceId();
  const session = await client.authenticateDevice(deviceId, true);

  // Update display name silently (ignore errors)
  try { await client.updateAccount(session, { display_name: username }); } catch {}

  const socket = client.createSocket(NAKAMA_USE_SSL, false);
  await socket.connect(session, true);

  return { client, session, socket };
}
