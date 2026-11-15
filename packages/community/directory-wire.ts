import { parseAbi } from "viem";

// Exact unchanged V1 read/event/registration wire surface.
export const directoryAbi = parseAbi([
  "function getCommunity(bytes32 communityId) view returns ((address registry,bytes32 tldHash,uint64 configurationRevision,(address controller,address publisher,address operatorPayments,address learningRecords,bytes32 sha256Digest,string uri) configuration,uint64 verificationRevision,(uint64 configurationRevision,uint64 hnsHeight,bytes32 hnsBlockHash,uint64 observedAt,uint64 validUntil,bytes32 evidenceSha256) verification,uint64 listingRevision,bool listed))",
  "event ConfigurationPublished(bytes32 indexed communityId,uint64 revision,address controller,address publisher,address operatorPayments,address learningRecords,bytes32 sha256Digest,string uri)",
  "function registerCommunity(address registry,(address controller,address publisher,address operatorPayments,address learningRecords,bytes32 sha256Digest,string uri) configuration) returns (bytes32 communityId)",
]);
