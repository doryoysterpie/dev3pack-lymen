// @limen/preflight (E-09): the transaction decoder, the pre-flight and the
// drain pattern, shared by the app and the server. Pure TypeScript: no React
// Native or Node imports; the network is reached only through an Rpc.

export { decodeBase58, decodePublicKey, encodeBase58 } from "./base58.ts";
export { decodeBase64, encodeBase64 } from "./base64.ts";
export * from "./programs.ts";

export {
  parseTransaction,
  type CompiledInstruction,
  type LookupReference,
  type MessageHeader,
  type ParsedMessage,
  type ParsedTransaction,
  type ParseResult,
  type WireProblem,
} from "./wire.ts";
export {
  messageAccounts,
  type Account,
  type LookupTables,
} from "./accounts.ts";
export {
  decodeInstruction,
  type Decoded,
  type TokenProgram,
  type UndecodedReason,
} from "./decode.ts";
export {
  summarizeTransaction,
  userAuthorizedTokenAccounts,
  userTokenAccounts,
  type Effect,
  type Place,
  type Signers,
  type TransactionSummary,
  type Undecoded,
} from "./summary.ts";
export {
  parseLookupTable,
  parseTokenAccount,
  type TokenAccount,
} from "./state.ts";

export {
  assertDevnet,
  jsonRpc,
  RPC_TIMEOUT_MS,
  RpcError,
  withTimeout,
  type AccountState,
  type Fetch,
  type FetchResponse,
  type Rpc,
  type Simulation,
} from "./rpc.ts";
export {
  recordedRpc,
  type RecordedAccount,
  type Recording,
} from "./recorded.ts";
export {
  balanceChanges,
  MAX_WATCHED,
  watchedAddresses,
  type BalanceChange,
} from "./simulate.ts";
export {
  forSigning,
  preflight,
  preflightTransaction,
  signBlocks,
  signingAllowed,
  toReport,
  type Preflight,
  type PreflightReport,
  type SignBlock,
  type SimulatedAt,
  type SimulationOutcome,
} from "./preflight.ts";
export {
  drainingChange,
  drainPattern,
  handsOverControl,
  SWEEP_DIVISOR,
} from "./drain.ts";
export {
  SCRUBBED,
  scrubAddresses,
  USER_MARKER,
  USER_AUTHORIZED_TOKEN_ACCOUNT_MARKER,
  USER_TOKEN_ACCOUNT_MARKER,
  withMarker,
  withMarkers,
} from "./marker.ts";
