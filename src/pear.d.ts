// Narrow declarations for the installed Pear APIs used by this adapter.
// These packages do not ship TypeScript declarations; keep additions aligned
// with their runtime source and the real replication tests.
declare module 'hypercore-crypto' {
  export interface KeyPair { publicKey: Buffer; secretKey: Buffer }
  const crypto: {
    keyPair(): KeyPair
    randomBytes(size: number): Buffer
  }
  export default crypto
}

declare module 'corestore' {
  import type { Duplex } from 'streamx'
  export default class Corestore {
    constructor(directory: string)
    replicate(connection: Duplex): Duplex
    replicate(initiator: boolean): Duplex
    close(): Promise<void>
  }
}

declare module 'hyperdrive' {
  import type Corestore from 'corestore'
  import type { Readable, Writable } from 'streamx'
  interface Entry {
    key: string
    value: { blob: { byteLength: number } | null }
  }
  export default class Hyperdrive {
    constructor(store: Corestore, key?: Buffer)
    readonly key: Buffer
    readonly discoveryKey: Buffer
    readonly writable: boolean
    readonly version: number
    readonly core: { findingPeers(): () => void; length: number }
    ready(): Promise<void>
    close(): Promise<void>
    update(options: { wait: boolean }): Promise<boolean>
    entry(path: string, options: { wait: boolean }): Promise<Entry | null>
    get(path: string, options: { wait: boolean }): Promise<Buffer | null>
    put(path: string, data: Buffer): Promise<void>
    list(path: string, options: { recursive: boolean; wait: boolean }): AsyncIterable<Entry>
    createWriteStream(path: string, options: { dedup: boolean }): Writable
    createReadStream(path: string, options: { wait: boolean }): Readable
  }
}

declare module 'hyperswarm' {
  import type { KeyPair } from 'hypercore-crypto'
  import type { Duplex } from 'streamx'
  export interface PeerConnection extends Duplex { remotePublicKey: Buffer }
  export type Bootstrap = Array<string | { host: string; port: number }>
  export default class Hyperswarm {
    constructor(options: {
      keyPair: KeyPair
      bootstrap?: Bootstrap
      firewall: (publicKey: Buffer) => boolean
    })
    connections: Set<PeerConnection>
    peers: Map<string, { ban(value: boolean): void }>
    on(event: 'connection', listener: (connection: PeerConnection) => void): this
    on(event: 'error', listener: (error: Error) => void): this
    join(topic: Buffer, options: { server: boolean; client: boolean }): unknown
    joinPeer(key: Buffer): void
    leavePeer(key: Buffer): void
    flush(): Promise<void>
    destroy(): Promise<void>
  }
}
