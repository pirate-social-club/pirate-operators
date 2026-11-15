// Generated from actual solc ABI/AST by harness/megaeth/generate-publication-consent.ts.
export const publicationConsentAbi = [
  {
    "type": "function",
    "name": "checkGrant",
    "inputs": [
      {
        "name": "id",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "learner",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "purposeHash",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "publicationTarget",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "policyHash",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "boundAt",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "outputs": [
      {
        "name": "allowed",
        "type": "bool",
        "internalType": "bool"
      },
      {
        "name": "reason",
        "type": "uint8",
        "internalType": "uint8"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "communityId",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "configurePurpose",
    "inputs": [
      {
        "name": "purpose",
        "type": "string",
        "internalType": "string"
      },
      {
        "name": "expectedPermissionRevision",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "expectedConfigurationRevision",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "descriptor",
        "type": "tuple",
        "internalType": "struct ICommunityPublicationConsentV1.PurposeDescriptor",
        "components": [
          {
            "name": "target",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "runtimeHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "policyHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "maxGrantDurationSeconds",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "maxSubmissionDelaySeconds",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "enabled",
            "type": "bool",
            "internalType": "bool"
          }
        ]
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "consentVersion",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint8",
        "internalType": "uint8"
      }
    ],
    "stateMutability": "pure"
  },
  {
    "type": "function",
    "name": "correctionDigest",
    "inputs": [
      {
        "name": "c",
        "type": "tuple",
        "internalType": "struct ICommunityPublicationConsentV1.PublicationCorrection",
        "components": [
          {
            "name": "learner",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "communityId",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "purpose",
            "type": "string",
            "internalType": "string"
          },
          {
            "name": "publicationTarget",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "publicationTargetRuntimeHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "permissionRevision",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "policyHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "withdrawalEpoch",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "resultId",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "originalGrantId",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "previousCommitment",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "correctedCommitment",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "reasonHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "nonce",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "issuedAt",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "submitBefore",
            "type": "uint64",
            "internalType": "uint64"
          }
        ]
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "grant",
    "inputs": [
      {
        "name": "g",
        "type": "tuple",
        "internalType": "struct ICommunityPublicationConsentV1.PublicationGrant",
        "components": [
          {
            "name": "learner",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "communityId",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "purpose",
            "type": "string",
            "internalType": "string"
          },
          {
            "name": "publicationTarget",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "publicationTargetRuntimeHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "permissionRevision",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "policyHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "withdrawalEpoch",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "nonce",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "issuedAt",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "validAfter",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "expiresAt",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "submitBefore",
            "type": "uint64",
            "internalType": "uint64"
          }
        ]
      },
      {
        "name": "signature",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "grantDigest",
    "inputs": [
      {
        "name": "g",
        "type": "tuple",
        "internalType": "struct ICommunityPublicationConsentV1.PublicationGrant",
        "components": [
          {
            "name": "learner",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "communityId",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "purpose",
            "type": "string",
            "internalType": "string"
          },
          {
            "name": "publicationTarget",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "publicationTargetRuntimeHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "permissionRevision",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "policyHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "withdrawalEpoch",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "nonce",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "issuedAt",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "validAfter",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "expiresAt",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "submitBefore",
            "type": "uint64",
            "internalType": "uint64"
          }
        ]
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "grantOf",
    "inputs": [
      {
        "name": "id",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "tuple",
        "internalType": "struct ICommunityPublicationConsentV1.PublicationGrant",
        "components": [
          {
            "name": "learner",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "communityId",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "purpose",
            "type": "string",
            "internalType": "string"
          },
          {
            "name": "publicationTarget",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "publicationTargetRuntimeHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "permissionRevision",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "policyHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "withdrawalEpoch",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "nonce",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "issuedAt",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "validAfter",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "expiresAt",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "submitBefore",
            "type": "uint64",
            "internalType": "uint64"
          }
        ]
      },
      {
        "name": "recordedAt",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "purpose",
    "inputs": [
      {
        "name": "purposeHash",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "revision",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "descriptor",
        "type": "tuple",
        "internalType": "struct ICommunityPublicationConsentV1.PurposeDescriptor",
        "components": [
          {
            "name": "target",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "runtimeHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "policyHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "maxGrantDurationSeconds",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "maxSubmissionDelaySeconds",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "enabled",
            "type": "bool",
            "internalType": "bool"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "withdraw",
    "inputs": [
      {
        "name": "w",
        "type": "tuple",
        "internalType": "struct ICommunityPublicationConsentV1.PublicationWithdrawal",
        "components": [
          {
            "name": "learner",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "communityId",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "purpose",
            "type": "string",
            "internalType": "string"
          },
          {
            "name": "expectedEpoch",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "nonce",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "submitBefore",
            "type": "uint64",
            "internalType": "uint64"
          }
        ]
      },
      {
        "name": "signature",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "withdrawalDigest",
    "inputs": [
      {
        "name": "w",
        "type": "tuple",
        "internalType": "struct ICommunityPublicationConsentV1.PublicationWithdrawal",
        "components": [
          {
            "name": "learner",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "communityId",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "purpose",
            "type": "string",
            "internalType": "string"
          },
          {
            "name": "expectedEpoch",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "nonce",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "submitBefore",
            "type": "uint64",
            "internalType": "uint64"
          }
        ]
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "withdrawalEpoch",
    "inputs": [
      {
        "name": "learner",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "purposeHash",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "event",
    "name": "PublicationGranted",
    "inputs": [
      {
        "name": "grantId",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "learner",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "purposeHash",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "grant",
        "type": "tuple",
        "indexed": false,
        "internalType": "struct ICommunityPublicationConsentV1.PublicationGrant",
        "components": [
          {
            "name": "learner",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "communityId",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "purpose",
            "type": "string",
            "internalType": "string"
          },
          {
            "name": "publicationTarget",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "publicationTargetRuntimeHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "permissionRevision",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "policyHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "withdrawalEpoch",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "nonce",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "issuedAt",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "validAfter",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "expiresAt",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "submitBefore",
            "type": "uint64",
            "internalType": "uint64"
          }
        ]
      },
      {
        "name": "recordedAt",
        "type": "uint64",
        "indexed": false,
        "internalType": "uint64"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "PublicationWithdrawn",
    "inputs": [
      {
        "name": "learner",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "purposeHash",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "previousEpoch",
        "type": "uint64",
        "indexed": false,
        "internalType": "uint64"
      },
      {
        "name": "nextEpoch",
        "type": "uint64",
        "indexed": false,
        "internalType": "uint64"
      },
      {
        "name": "withdrawalId",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "PurposeConfigured",
    "inputs": [
      {
        "name": "purposeHash",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "permissionRevision",
        "type": "uint64",
        "indexed": false,
        "internalType": "uint64"
      },
      {
        "name": "target",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      },
      {
        "name": "runtimeHash",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      },
      {
        "name": "policyHash",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      },
      {
        "name": "maxGrantDurationSeconds",
        "type": "uint64",
        "indexed": false,
        "internalType": "uint64"
      },
      {
        "name": "maxSubmissionDelaySeconds",
        "type": "uint64",
        "indexed": false,
        "internalType": "uint64"
      },
      {
        "name": "enabled",
        "type": "bool",
        "indexed": false,
        "internalType": "bool"
      }
    ],
    "anonymous": false
  },
  {
    "type": "error",
    "name": "InvalidConsent",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidCorrection",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidDescriptor",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidPurpose",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidSource",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidWindow",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NonceUsed",
    "inputs": []
  },
  {
    "type": "error",
    "name": "StaleRevision",
    "inputs": []
  },
  {
    "type": "error",
    "name": "Unauthorized",
    "inputs": []
  }
] as const;
export const publicationConsentTypes = {
  "PublicationGrant": [
    {
      "name": "learner",
      "type": "address"
    },
    {
      "name": "communityId",
      "type": "bytes32"
    },
    {
      "name": "purpose",
      "type": "string"
    },
    {
      "name": "publicationTarget",
      "type": "address"
    },
    {
      "name": "publicationTargetRuntimeHash",
      "type": "bytes32"
    },
    {
      "name": "permissionRevision",
      "type": "uint64"
    },
    {
      "name": "policyHash",
      "type": "bytes32"
    },
    {
      "name": "withdrawalEpoch",
      "type": "uint64"
    },
    {
      "name": "nonce",
      "type": "bytes32"
    },
    {
      "name": "issuedAt",
      "type": "uint64"
    },
    {
      "name": "validAfter",
      "type": "uint64"
    },
    {
      "name": "expiresAt",
      "type": "uint64"
    },
    {
      "name": "submitBefore",
      "type": "uint64"
    }
  ],
  "PublicationWithdrawal": [
    {
      "name": "learner",
      "type": "address"
    },
    {
      "name": "communityId",
      "type": "bytes32"
    },
    {
      "name": "purpose",
      "type": "string"
    },
    {
      "name": "expectedEpoch",
      "type": "uint64"
    },
    {
      "name": "nonce",
      "type": "bytes32"
    },
    {
      "name": "submitBefore",
      "type": "uint64"
    }
  ],
  "PublicationCorrection": [
    {
      "name": "learner",
      "type": "address"
    },
    {
      "name": "communityId",
      "type": "bytes32"
    },
    {
      "name": "purpose",
      "type": "string"
    },
    {
      "name": "publicationTarget",
      "type": "address"
    },
    {
      "name": "publicationTargetRuntimeHash",
      "type": "bytes32"
    },
    {
      "name": "permissionRevision",
      "type": "uint64"
    },
    {
      "name": "policyHash",
      "type": "bytes32"
    },
    {
      "name": "withdrawalEpoch",
      "type": "uint64"
    },
    {
      "name": "resultId",
      "type": "bytes32"
    },
    {
      "name": "originalGrantId",
      "type": "bytes32"
    },
    {
      "name": "previousCommitment",
      "type": "bytes32"
    },
    {
      "name": "correctedCommitment",
      "type": "bytes32"
    },
    {
      "name": "reasonHash",
      "type": "bytes32"
    },
    {
      "name": "nonce",
      "type": "bytes32"
    },
    {
      "name": "issuedAt",
      "type": "uint64"
    },
    {
      "name": "submitBefore",
      "type": "uint64"
    }
  ]
} as const;
