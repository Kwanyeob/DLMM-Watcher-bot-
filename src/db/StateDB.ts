import fs from 'fs';
import path from 'path';
import { PositionState } from '../types';
import { logger } from '../utils/logger';

const DB_PATH = path.join('data', 'positions.json');

interface DbSchema {
  positions: PositionState[];
}

function ensureDir(): void {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function read(): DbSchema {
  ensureDir();
  if (!fs.existsSync(DB_PATH)) return { positions: [] };
  const raw = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8')) as any;
  return { positions: raw.positions ?? [] };
}

function write(schema: DbSchema): void {
  ensureDir();
  fs.writeFileSync(DB_PATH, JSON.stringify(schema, null, 2), 'utf-8');
}

export class StateDB {
  add(pos: Omit<PositionState, 'shortId'>): PositionState {
    const schema = read();
    const usedIds = new Set(schema.positions.map(p => p.shortId));
    let shortId = 1;
    while (usedIds.has(shortId) && shortId <= 10) shortId++;
    const full: PositionState = { ...pos, shortId };
    schema.positions.push(full);
    write(schema);
    logger.debug(`StateDB: added position #${shortId} ${pos.address.slice(0, 8)}...`);
    return full;
  }

  update(address: string, patch: Partial<PositionState>): void {
    const schema = read();
    const idx = schema.positions.findIndex(p => p.address === address);
    if (idx === -1) return;
    schema.positions[idx] = { ...schema.positions[idx], ...patch };
    write(schema);
  }

  remove(address: string): void {
    const schema = read();
    schema.positions = schema.positions.filter(p => p.address !== address);
    write(schema);
    logger.debug(`StateDB: removed ${address.slice(0, 8)}...`);
  }

  getAll(): PositionState[] {
    return read().positions;
  }

  getByAddress(address: string): PositionState | undefined {
    return read().positions.find(p => p.address === address);
  }

  getByShortId(shortId: number): PositionState | undefined {
    return read().positions.find(p => p.shortId === shortId);
  }
}
