// Encoding helpers for SoftEther per-protocol options (GetProtoOptions / SetProtoOptions).
// The RPC uses parallel arrays: Name_str[], Type_u32[] (1=string, 2=bool, 3=uint32) and
// Value_bin[] (base64 of the raw value: strings NUL-terminated UTF-8, bool 1 byte, uint32 LE).

export const PROTO_TYPE = { STRING: 1, BOOL: 2, UINT32: 3 } as const;
export const PROTO_TYPE_LABEL: Record<number, string> = { 1: "string", 2: "boolean", 3: "uint32" };

export interface ProtoOptionsRaw {
  Protocol_str?: string;
  Name_str?: string[];
  Type_u32?: number[];
  Value_bin?: string[];
}

export interface ProtoOption {
  name: string;
  type: number;
  /** Decoded value; for unknown types the raw base64 string is kept. */
  value: string | boolean | number;
  /** Original base64 value (used to detect changes and to pass unknown types through). */
  raw: string;
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64 || "");
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function decodeValue(type: number, b64: string): string | boolean | number {
  const b = b64ToBytes(b64);
  switch (type) {
    case PROTO_TYPE.STRING: {
      let end = b.indexOf(0);
      if (end < 0) end = b.length;
      return new TextDecoder().decode(b.subarray(0, end));
    }
    case PROTO_TYPE.BOOL:
      return b.length > 0 && b[0] !== 0;
    case PROTO_TYPE.UINT32: {
      const buf = new Uint8Array(4);
      buf.set(b.subarray(0, 4));
      return new DataView(buf.buffer).getUint32(0, true);
    }
    default:
      return b64;
  }
}

export function encodeValue(type: number, value: string | boolean | number, raw: string): string {
  switch (type) {
    case PROTO_TYPE.STRING: {
      const s = new TextEncoder().encode(String(value ?? ""));
      const out = new Uint8Array(s.length + 1);
      out.set(s);
      return bytesToB64(out);
    }
    case PROTO_TYPE.BOOL:
      return bytesToB64(new Uint8Array([value ? 1 : 0]));
    case PROTO_TYPE.UINT32: {
      const out = new Uint8Array(4);
      const n = Math.max(0, Math.min(0xffffffff, Math.trunc(Number(value) || 0)));
      new DataView(out.buffer).setUint32(0, n, true);
      return bytesToB64(out);
    }
    default:
      return raw;
  }
}

export function decodeProtoOptions(r: ProtoOptionsRaw | undefined): ProtoOption[] {
  const names = r?.Name_str ?? [];
  const typesArr = r?.Type_u32 ?? [];
  const vals = r?.Value_bin ?? [];
  return names.map((name, i) => {
    const type = typesArr[i] ?? 0;
    const raw = vals[i] ?? "";
    return { name, type, raw, value: decodeValue(type, raw) };
  });
}

/** Re-encode every option (the server expects the complete list back). */
export function encodeProtoOptions(protocol: string, opts: ProtoOption[]): Required<ProtoOptionsRaw> {
  return {
    Protocol_str: protocol,
    Name_str: opts.map((o) => o.name),
    Type_u32: opts.map((o) => o.type),
    Value_bin: opts.map((o) => encodeValue(o.type, o.value, o.raw)),
  };
}

export function isSecretOption(name: string) {
  return /key|secret|password|psk/i.test(name);
}

/** Human descriptions for the option names SoftEther 5.x exposes (from the server source / docs). */
export const PROTO_OPTION_DOCS: Record<string, Record<string, { label: string; doc: string; unit?: string }>> = {
  OpenVPN: {
    Enabled: { label: "Enabled", doc: "Accept connections from OpenVPN clients (OpenVPN clone server function)." },
    DefaultClientOption: {
      label: "Default client option string",
      doc: "Comma-separated option string advertised to clients that do not send their own (e.g. dev-type, link-mtu, tun-mtu, cipher, auth, keysize, key-method, tls-client). Change only if you know OpenVPN option negotiation.",
    },
    Obfuscation: { label: "Obfuscation", doc: "Enable XOR-style obfuscation of OpenVPN packets (requires a client patched with the same obfuscation). Helps against DPI; incompatible with stock OpenVPN clients." },
    ObfuscationMask: { label: "Obfuscation mask", doc: "Secret mask string used by the obfuscation. Must match the client configuration exactly." },
    PingSendInterval: { label: "Ping send interval", unit: "ms", doc: "Interval between keep-alive pings sent to OpenVPN clients, in milliseconds." },
    PushDummyIPv4AddressOnL2Mode: {
      label: "Push dummy IPv4 on L2 (TAP) mode",
      doc: "In bridged (TAP) mode, push a dummy IPv4 address so clients that require an address (e.g. some mobile clients) do not fail; the real address is then obtained by DHCP.",
    },
    Timeout: { label: "Timeout", unit: "ms", doc: "Session is considered dead when nothing is received for this many milliseconds." },
  },
  SSTP: {
    Enabled: { label: "Enabled", doc: "Accept connections from Microsoft SSTP clients (Windows built-in VPN). The server certificate CN must match the host name clients use." },
  },
  WireGuard: {
    Enabled: { label: "Enabled", doc: "Accept WireGuard connections on the server's UDP listener ports. Client public keys must be mapped to a hub/user." },
    PrivateKey: { label: "Server private key", doc: "Base64 Curve25519 private key of the server. Clients configure the matching public key as their peer. Changing it breaks every existing WireGuard client." },
    PresharedKey: { label: "Pre-shared key", doc: "Optional base64 symmetric key mixed into the handshake for post-quantum resistance. Every client must use the same PresharedKey." },
  },
};

export function optionMeta(protocol: string, name: string) {
  return PROTO_OPTION_DOCS[protocol]?.[name] ?? { label: name, doc: "" };
}
