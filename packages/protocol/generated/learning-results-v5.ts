// Generated from actual solc ABI/AST by harness/megaeth/generate-publication-consent.ts.
export const learningResultsV5Abi = [
  {
    "type": "constructor",
    "inputs": [
      {
        "name": "selectedDirectory",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "expectedRuntime",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "community",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "CORRECTION_TYPEHASH",
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
    "name": "DANCE_PURPOSE",
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
    "name": "DOMAIN_SEPARATOR",
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
    "name": "EPOCH_START",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "GRANT_TYPEHASH",
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
    "name": "KARAOKE",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint8",
        "internalType": "uint8"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "KARAOKE_PURPOSE",
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
    "name": "MAX_LINES",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint16",
        "internalType": "uint16"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "MAX_SOURCE_LINES",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint16",
        "internalType": "uint16"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "PERIOD_SECONDS",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "RESULT_DOMAIN",
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
    "name": "REVIEW_PURPOSE",
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
    "name": "STUDY",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint8",
        "internalType": "uint8"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "STUDY_PURPOSE",
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
    "name": "VERSION",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint8",
        "internalType": "uint8"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "WITHDRAWAL_TYPEHASH",
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
    "name": "activatePolicy",
    "inputs": [
      {
        "name": "activity",
        "type": "uint8",
        "internalType": "uint8"
      },
      {
        "name": "policy",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "uri",
        "type": "string",
        "internalType": "string"
      },
      {
        "name": "period",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "expectedConfigurationRevision",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
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
        "name": "p",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "target",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "policy",
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
    "name": "commitmentOf",
    "inputs": [
      {
        "name": "r",
        "type": "tuple",
        "internalType": "struct LearningResultsV5.Result",
        "components": [
          {
            "name": "sessionId",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "learner",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "grantId",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "song",
            "type": "tuple",
            "internalType": "struct LearningResultsV5.Song",
            "components": [
              {
                "name": "chainId",
                "type": "uint256",
                "internalType": "uint256"
              },
              {
                "name": "posts",
                "type": "address",
                "internalType": "address"
              },
              {
                "name": "communityId",
                "type": "bytes32",
                "internalType": "bytes32"
              },
              {
                "name": "postId",
                "type": "bytes32",
                "internalType": "bytes32"
              }
            ]
          },
          {
            "name": "contentRevision",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "exercisesHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "linesTotal",
            "type": "uint16",
            "internalType": "uint16"
          },
          {
            "name": "activity",
            "type": "uint8",
            "internalType": "uint8"
          },
          {
            "name": "grader",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "scoringPolicy",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "qualificationPolicy",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "startedAt",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "completedAt",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "status",
            "type": "uint8",
            "internalType": "uint8"
          },
          {
            "name": "revision",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "supersedes",
            "type": "bytes32",
            "internalType": "bytes32"
          }
        ]
      },
      {
        "name": "outcomes",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "pure"
  },
  {
    "type": "function",
    "name": "commitments",
    "inputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
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
        "name": "name",
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
        "name": "d",
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
    "name": "correct",
    "inputs": [
      {
        "name": "previous",
        "type": "tuple",
        "internalType": "struct LearningResultsV5.Result",
        "components": [
          {
            "name": "sessionId",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "learner",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "grantId",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "song",
            "type": "tuple",
            "internalType": "struct LearningResultsV5.Song",
            "components": [
              {
                "name": "chainId",
                "type": "uint256",
                "internalType": "uint256"
              },
              {
                "name": "posts",
                "type": "address",
                "internalType": "address"
              },
              {
                "name": "communityId",
                "type": "bytes32",
                "internalType": "bytes32"
              },
              {
                "name": "postId",
                "type": "bytes32",
                "internalType": "bytes32"
              }
            ]
          },
          {
            "name": "contentRevision",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "exercisesHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "linesTotal",
            "type": "uint16",
            "internalType": "uint16"
          },
          {
            "name": "activity",
            "type": "uint8",
            "internalType": "uint8"
          },
          {
            "name": "grader",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "scoringPolicy",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "qualificationPolicy",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "startedAt",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "completedAt",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "status",
            "type": "uint8",
            "internalType": "uint8"
          },
          {
            "name": "revision",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "supersedes",
            "type": "bytes32",
            "internalType": "bytes32"
          }
        ]
      },
      {
        "name": "oldOutcomes",
        "type": "bytes",
        "internalType": "bytes"
      },
      {
        "name": "outcomes",
        "type": "bytes",
        "internalType": "bytes"
      },
      {
        "name": "status",
        "type": "uint8",
        "internalType": "uint8"
      },
      {
        "name": "permit",
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
      },
      {
        "name": "signature",
        "type": "bytes",
        "internalType": "bytes"
      },
      {
        "name": "expectedConfigurationRevision",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
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
    "name": "directory",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract ICommunityDirectoryV1"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "directoryRuntimeHash",
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
    "name": "graders",
    "inputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "",
        "type": "uint8",
        "internalType": "uint8"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
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
    "name": "invalidate",
    "inputs": [
      {
        "name": "previous",
        "type": "tuple",
        "internalType": "struct LearningResultsV5.Result",
        "components": [
          {
            "name": "sessionId",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "learner",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "grantId",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "song",
            "type": "tuple",
            "internalType": "struct LearningResultsV5.Song",
            "components": [
              {
                "name": "chainId",
                "type": "uint256",
                "internalType": "uint256"
              },
              {
                "name": "posts",
                "type": "address",
                "internalType": "address"
              },
              {
                "name": "communityId",
                "type": "bytes32",
                "internalType": "bytes32"
              },
              {
                "name": "postId",
                "type": "bytes32",
                "internalType": "bytes32"
              }
            ]
          },
          {
            "name": "contentRevision",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "exercisesHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "linesTotal",
            "type": "uint16",
            "internalType": "uint16"
          },
          {
            "name": "activity",
            "type": "uint8",
            "internalType": "uint8"
          },
          {
            "name": "grader",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "scoringPolicy",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "qualificationPolicy",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "startedAt",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "completedAt",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "status",
            "type": "uint8",
            "internalType": "uint8"
          },
          {
            "name": "revision",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "supersedes",
            "type": "bytes32",
            "internalType": "bytes32"
          }
        ]
      },
      {
        "name": "outcomes",
        "type": "bytes",
        "internalType": "bytes"
      },
      {
        "name": "reason",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "permit",
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
      },
      {
        "name": "signature",
        "type": "bytes",
        "internalType": "bytes"
      },
      {
        "name": "expectedConfigurationRevision",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "periodOf",
    "inputs": [
      {
        "name": "timestamp",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "stateMutability": "pure"
  },
  {
    "type": "function",
    "name": "policyFor",
    "inputs": [
      {
        "name": "activity",
        "type": "uint8",
        "internalType": "uint8"
      },
      {
        "name": "period",
        "type": "uint64",
        "internalType": "uint64"
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
    "name": "publish",
    "inputs": [
      {
        "name": "r",
        "type": "tuple",
        "internalType": "struct LearningResultsV5.Result",
        "components": [
          {
            "name": "sessionId",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "learner",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "grantId",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "song",
            "type": "tuple",
            "internalType": "struct LearningResultsV5.Song",
            "components": [
              {
                "name": "chainId",
                "type": "uint256",
                "internalType": "uint256"
              },
              {
                "name": "posts",
                "type": "address",
                "internalType": "address"
              },
              {
                "name": "communityId",
                "type": "bytes32",
                "internalType": "bytes32"
              },
              {
                "name": "postId",
                "type": "bytes32",
                "internalType": "bytes32"
              }
            ]
          },
          {
            "name": "contentRevision",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "exercisesHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "linesTotal",
            "type": "uint16",
            "internalType": "uint16"
          },
          {
            "name": "activity",
            "type": "uint8",
            "internalType": "uint8"
          },
          {
            "name": "grader",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "scoringPolicy",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "qualificationPolicy",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "startedAt",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "completedAt",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "status",
            "type": "uint8",
            "internalType": "uint8"
          },
          {
            "name": "revision",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "supersedes",
            "type": "bytes32",
            "internalType": "bytes32"
          }
        ]
      },
      {
        "name": "outcomes",
        "type": "bytes",
        "internalType": "bytes"
      },
      {
        "name": "expectedConfigurationRevision",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "purpose",
    "inputs": [
      {
        "name": "p",
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
    "name": "setEligibility",
    "inputs": [
      {
        "name": "learner",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "eligible",
        "type": "bool",
        "internalType": "bool"
      },
      {
        "name": "effectiveAt",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "reason",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "expectedConfigurationRevision",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "setGrader",
    "inputs": [
      {
        "name": "grader",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "activity",
        "type": "uint8",
        "internalType": "uint8"
      },
      {
        "name": "allowed",
        "type": "bool",
        "internalType": "bool"
      },
      {
        "name": "expectedConfigurationRevision",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "usedNonces",
    "inputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
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
        "name": "",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "",
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
    "name": "EligibilityChangedV5",
    "inputs": [
      {
        "name": "learner",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "eligible",
        "type": "bool",
        "indexed": false,
        "internalType": "bool"
      },
      {
        "name": "effectiveAt",
        "type": "uint64",
        "indexed": false,
        "internalType": "uint64"
      },
      {
        "name": "reasonCode",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "GraderSetV5",
    "inputs": [
      {
        "name": "grader",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "activity",
        "type": "uint8",
        "indexed": true,
        "internalType": "uint8"
      },
      {
        "name": "allowed",
        "type": "bool",
        "indexed": false,
        "internalType": "bool"
      },
      {
        "name": "configurationRevision",
        "type": "uint64",
        "indexed": false,
        "internalType": "uint64"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "PolicyActivatedV5",
    "inputs": [
      {
        "name": "activity",
        "type": "uint8",
        "indexed": true,
        "internalType": "uint8"
      },
      {
        "name": "policyHash",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "policyURI",
        "type": "string",
        "indexed": false,
        "internalType": "string"
      },
      {
        "name": "effectivePeriod",
        "type": "uint64",
        "indexed": false,
        "internalType": "uint64"
      },
      {
        "name": "clockVersion",
        "type": "uint8",
        "indexed": false,
        "internalType": "uint8"
      },
      {
        "name": "configurationRevision",
        "type": "uint64",
        "indexed": false,
        "internalType": "uint64"
      }
    ],
    "anonymous": false
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
    "type": "event",
    "name": "ResultCorrectedV5",
    "inputs": [
      {
        "name": "sessionId",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "correctionId",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "originalGrantId",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "previousCommitment",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      },
      {
        "name": "correctedCommitment",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      },
      {
        "name": "reasonHash",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "ResultInvalidatedV5",
    "inputs": [
      {
        "name": "sessionId",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "revision",
        "type": "uint32",
        "indexed": true,
        "internalType": "uint32"
      },
      {
        "name": "reason",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      },
      {
        "name": "correctionId",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "ResultPublishedV5",
    "inputs": [
      {
        "name": "sessionId",
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
        "name": "revision",
        "type": "uint32",
        "indexed": true,
        "internalType": "uint32"
      },
      {
        "name": "result",
        "type": "tuple",
        "indexed": false,
        "internalType": "struct LearningResultsV5.Result",
        "components": [
          {
            "name": "sessionId",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "learner",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "grantId",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "song",
            "type": "tuple",
            "internalType": "struct LearningResultsV5.Song",
            "components": [
              {
                "name": "chainId",
                "type": "uint256",
                "internalType": "uint256"
              },
              {
                "name": "posts",
                "type": "address",
                "internalType": "address"
              },
              {
                "name": "communityId",
                "type": "bytes32",
                "internalType": "bytes32"
              },
              {
                "name": "postId",
                "type": "bytes32",
                "internalType": "bytes32"
              }
            ]
          },
          {
            "name": "contentRevision",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "exercisesHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "linesTotal",
            "type": "uint16",
            "internalType": "uint16"
          },
          {
            "name": "activity",
            "type": "uint8",
            "internalType": "uint8"
          },
          {
            "name": "grader",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "scoringPolicy",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "qualificationPolicy",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "startedAt",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "completedAt",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "status",
            "type": "uint8",
            "internalType": "uint8"
          },
          {
            "name": "revision",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "supersedes",
            "type": "bytes32",
            "internalType": "bytes32"
          }
        ]
      },
      {
        "name": "outcomes",
        "type": "bytes",
        "indexed": false,
        "internalType": "bytes"
      },
      {
        "name": "commitment",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      },
      {
        "name": "publisher",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      },
      {
        "name": "configurationRevision",
        "type": "uint64",
        "indexed": false,
        "internalType": "uint64"
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
export const learningResultsV5Build = {
  "schema": "pirate.publication-build/1",
  "contract": "LearningResultsV5",
  "compiler": "0.8.30+commit.73712a01",
  "evmVersion": "cancun",
  "optimizerRuns": 200,
  "viaIR": false,
  "abiSha256": "0x369e6a3f7af9051e6912ff22a094e2ad40b2af7b991cc7746a6885e8a26665f3",
  "runtimeTemplateHash": "0xbe9b77295c0889761e09bea1f351c714295a124a9fd2b5f796bf54fb191e82d3",
  "runtimeBytes": 23300,
  "immutableReferences": {
    "11683": [
      {
        "start": 1411,
        "length": 32
      },
      {
        "start": 2894,
        "length": 32
      },
      {
        "start": 4610,
        "length": 32
      },
      {
        "start": 5219,
        "length": 32
      },
      {
        "start": 14344,
        "length": 32
      },
      {
        "start": 14676,
        "length": 32
      },
      {
        "start": 15871,
        "length": 32
      }
    ],
    "11686": [
      {
        "start": 1592,
        "length": 32
      },
      {
        "start": 14251,
        "length": 32
      },
      {
        "start": 14382,
        "length": 32
      },
      {
        "start": 14563,
        "length": 32
      },
      {
        "start": 14714,
        "length": 32
      }
    ],
    "11688": [
      {
        "start": 1136,
        "length": 32
      },
      {
        "start": 14284,
        "length": 32
      },
      {
        "start": 14596,
        "length": 32
      }
    ]
  },
  "sources": {
    "contracts/LearningResultsV5.sol": {
      "keccak256": "0x34ccab47f2fb0a72397138331237a3c057abbd2fe7461c7783274eda2cd364f1",
      "license": "UNLICENSED",
      "urls": [
        "bzz-raw://7e2bb384cf7d8f77dbb35d132107d18f03212e7f611bb79f34341c8ca2c594ef",
        "dweb:/ipfs/QmQzJUHzfitqVSK4BR5X4NUVwPJ2XaR147beVfP24BhkRG"
      ]
    },
    "contracts/interfaces/community/ICommunityDirectoryV1.sol": {
      "keccak256": "0xb620d0288bf64dc50aeb08445c9ded516e824730cfb902355c2028a843afe897",
      "license": "UNLICENSED",
      "urls": [
        "bzz-raw://71ebc28636aef8ec5d18ad4dbfde18cc7f6f809e0bcb3fae201e274ef7394203",
        "dweb:/ipfs/QmNf3LWJy6YeSBgegWQUjjDbTGgsr8LkJWLE4PdNMTd14C"
      ]
    },
    "contracts/interfaces/community/ICommunityPublicationConsentV1.sol": {
      "keccak256": "0x52db04fd45ff80203c4fbcc7904811df3d046aa67c2b35d3ae691c9f2cdf1b3f",
      "license": "UNLICENSED",
      "urls": [
        "bzz-raw://477c3c7bf22d0c32d0b9303b3412f61fe008fc2008b6b210d93bdb4ac886984b",
        "dweb:/ipfs/QmcUpa47nWDS2H6a8Y7inWYwAKUqPqxb9fmu9KR6y7v3g9"
      ]
    },
    "contracts/learning/PublicationConsentV1.sol": {
      "keccak256": "0x47ba196910d8763e8ea0d0a3d072ef4ff3483d6f53e4d5b5bbf2d3c5dae4167c",
      "license": "UNLICENSED",
      "urls": [
        "bzz-raw://43bbfabc5af9481893acd87220e2c182ef0fcb4583d688e7f5084ebb51ac5781",
        "dweb:/ipfs/QmTPRe2MUdfzYdDChsLKNkkWCQrd3BnVgJEhGwz5w4kZDJ"
      ]
    }
  }
} as const;
export const learningResultsV5RuntimeTemplate = "0x608060405234801561000f575f5ffd5b5060043610610255575f3560e01c80637f50861a11610140578063d705fc96116100bf578063ecf8510611610084578063ecf8510614610737578063f8ef05f51461074a578063fdfd5a251461075d578063feb6172414610784578063feddcbcc146107a6578063ffa1ad74146107cd575f5ffd5b8063d705fc96146106b4578063d7ddd033146106e7578063dc3512aa146106f1578063dcdc7c191461071d578063dd49979b14610724575f5ffd5b8063c41c2f2411610105578063c41c2f2414610633578063cb9e4b2014610672578063d025d3aa14610685578063d2fd4b481461068e578063d35c7395146106a1575f5ffd5b80637f50861a1461057e578063839df945146105a55780639aee26f1146105c45780639e61d307146105e55780639e7103351461060c575f5ffd5b806346d62a63116101d75780636ff330a01161019c5780636ff330a0146104f7578063707d9d761461050b57806378efb5c41461051e57806379bee3711461054557806379c1e09e146105585780637d28dc731461056b575f5ffd5b806346d62a63146104925780634ccae0b31461049d5780635484062a146104c857806358a51283146104dc57806365dfbd93146104e4575f5ffd5b80632064ea1b1161021d5780632064ea1b146104005780632bd8b05a146104135780633644e515146104265780633b0a93dc1461042e578063448a975d1461046b575f5ffd5b8063012bf24a14610259578063049b5edb1461027a578063073f5d9f1461028f5780631270f5b5146102c45780631a6d00ec146103e6575b5f5ffd5b6102626107d081565b60405161ffff90911681526020015b60405180910390f35b61028d6102883660046141be565b6107d5565b005b6102b67fe902c899d5a9ec9321b98745344753935b8c6099e12aa3071331a08f7195174981565b604051908152602001610271565b61037f6102d2366004614215565b6040805160c0810182525f80825260208201819052918101829052606081018290526080810182905260a0810182905250505f90815260208181526040918290208054835160c08101855260018301546001600160a01b03168152600283015493810193909352600382015493830193909352600401546001600160401b038082166060840152600160401b820481166080840152600160801b90910460ff16151560a083015290911691565b604080516001600160401b03938416815282516001600160a01b03166020808301919091528301518183015290820151606080830191909152820151831660808083019190915282015190921660a0808401919091520151151560c082015260e001610271565b6103ee600181565b60405160ff9091168152602001610271565b61028d61040e366004614298565b6108b5565b61028d6104213660046143a6565b610b00565b6102b6610de6565b61045b61043c36600461440d565b600460209081525f928352604080842090915290825290205460ff1681565b6040519015158152602001610271565b6102b67f000000000000000000000000000000000000000000000000000000000000000081565b6102b6636ae7701081565b6104b06104ab366004614440565b610e8a565b6040516001600160401b039091168152602001610271565b6102b65f516020615aaf5f395f51905f5281565b6103ee600281565b61028d6104f236600461445b565b610f02565b6102b65f516020615a8f5f395f51905f5281565b61028d6105193660046144c6565b611418565b6102b67fe2c61f721e74cc9550ff2dd69ff27ea04e9b6e2a1206601b97754a6d63bdc22181565b61028d6105533660046144f9565b611964565b6102b661056636600461456e565b611c90565b61028d61057936600461459f565b611e5f565b6102b67f000000000000000000000000000000000000000000000000000000000000000081565b6102b66105b3366004614215565b60056020525f908152604090205481565b6105d76105d2366004614215565b612035565b604051610271929190614697565b6102b67f08aaf5e7a98710f56656e185fdc1891b69e9445877f9f15cce76abafdda7ce3d81565b6102b67f9e7027de04329f181932262b430964848a31faf668527c9b8b67ea9fafb095ad81565b61065a7f000000000000000000000000000000000000000000000000000000000000000081565b6040516001600160a01b039091168152602001610271565b6102b6610680366004614a86565b612213565b6102626101f481565b6102b661069c366004614ae6565b612267565b6102b66106af366004614b1b565b612321565b6104b06106c2366004614b4c565b600260209081525f92835260408084209091529082529020546001600160401b031681565b6102b66201518081565b6107046106ff366004614b76565b6123f6565b60408051921515835260ff909116602083015201610271565b60016103ee565b61028d610732366004614bd9565b612637565b6102b6610745366004614c48565b61282a565b61028d610758366004614c79565b6129d7565b6102b67f2575c3f2a3e985f2d0dce8b2641759ef6e568a1dc4da23ca8434de93458b015f81565b61045b610792366004614215565b60036020525f908152604090205460ff1681565b6102b67f20f31300875c2c8cb7c66054f64a9cb6d30e921fbb93f7e80dc2282ca08fa09c81565b6103ee600581565b6107de81612a3d565b6001600160a01b03841661082a5760405162461bcd60e51b815260206004820152600e60248201526d34b73b30b634b22fb3b930b232b960911b60448201526064015b60405180910390fd5b61083383612a75565b506001600160a01b0384165f81815260046020908152604080832060ff881680855290835292819020805460ff191687151590811790915581519081526001600160401b038616928101929092529192917fcc03a153b190db1f26ba803c36dffc89225cdb97b7d164a6be583289758d4ae4910160405180910390a350505050565b6108d06108ca6101608c016101408d01614cdd565b82612af4565b6108db8a8a8a612b91565b60018560ff16101580156108f3575060048560ff1611155b6109395760405162461bcd60e51b8152602060048201526017602482015276696e76616c69645f7465726d696e616c5f73746174757360481b6044820152606401610821565b61096e61094e6101608c016101408d01614cdd565b866109616101408e016101208f01614cf6565b8d61010001358b8b612c49565b888860405161097e929190614d0f565b60405180910390208787604051610996929190614d0f565b60405180910390201415806109c257506109b86102208b016102008c01614cdd565b60ff168560ff1614155b6109fa5760405162461bcd60e51b81526020600482015260096024820152686e6f5f6368616e676560b81b6044820152606401610821565b5f610a0a368c90038c018c614d1e565b6101c081018051919250610a1d82614d4d565b63ffffffff169052508a355f908152600560205260408120546101e083015260ff87166101a0830152610a568c838b8b8a8a8a886130eb565b9050610a99828a8a8080601f0160208091040260200160405190810160405280939291908181526020018383808284375f9201919091525088925061322c915050565b60408281015183516101e08501515f8281526005602090815285822054865193845290830152818501529251919284927ee007e049b1764ae63e7647bb47209e035c787abb0aa07316fb0b10c52a3f1f9181900360600190a4505050505050505050505050565b5f610b4a610b116040860186614d71565b8080601f0160208091040260200160405190810160405280939291908181526020018383808284375f920191909152506132b592505050565b90507f00000000000000000000000000000000000000000000000000000000000000008460200135141580610bd5575060025f610b8a6020870187614db3565b6001600160a01b0316815260208082019290925260409081015f9081208482529092529020546001600160401b0316610bc96080860160608701614440565b6001600160401b031614155b15610bf357604051630df0f4e960e41b815260040160405180910390fd5b610c0360c0850160a08601614440565b6001600160401b03164210610c2b5760405163392334ed60e01b815260040160405180910390fd5b5f610c3585612321565b9050610c446020860186614db3565b6001600160a01b0316336001600160a01b031614158015610c7a5750610c78610c706020870187614db3565b828686613361565b155b15610c9857604051630df0f4e960e41b815260040160405180910390fd5b610ce47f2575c3f2a3e985f2d0dce8b2641759ef6e568a1dc4da23ca8434de93458b015f610cc96020880188614db3565b84610cda60808a0160608b01614440565b8960800135613500565b610cf46080860160608701614440565b610cff906001614dce565b60025f610d0f6020890189614db3565b6001600160a01b0316815260208082019290925260409081015f908120868252835220805467ffffffffffffffff19166001600160401b0393909316929092179091558290610d6090870187614db3565b6001600160a01b03167f13aefe8cac80b2da5f913f7822327f174175834b613ad6290ebdf380d896cac4610d9a6080890160608a01614440565b610daa60808a0160608b01614440565b610db5906001614dce565b604080516001600160401b039384168152929091166020830152810185905260600160405180910390a35050505050565b604080517f8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f60208201527fb603bc3a16c2e06c28dbd9ee3a460eab87ff62167ccebe05235151186c50758a918101919091527fc89efdaa54c0f20c7adf612882df0950f5a951637e0307cdcb4c672f298b8bc660608201524660808201523060a08201525f9060c00160405160208183030381529060405280519060200120905090565b5f636ae77010826001600160401b03161015610ed75760405162461bcd60e51b815260206004820152600c60248201526b0c4caccdee4cabecae0dec6d60a31b6044820152606401610821565b62015180610ef2636ae770106001600160401b038516614ded565b610efc9190614e00565b92915050565b610f176108ca61016086016101408701614cdd565b610f2961018085016101608601614db3565b6001600160a01b0316336001600160a01b031614610f765760405162461bcd60e51b815260206004820152600a6024820152693737ba2fb3b930b232b960b11b6044820152606401610821565b610f8861024085016102208601614e1f565b63ffffffff166001148015610fa05750610240840135155b8015610fb9575083355f90815260056020526040902054155b610ffd5760405162461bcd60e51b8152602060048201526015602482015274323ab83634b1b0ba32afb7b92fb932bb34b9b4b7b760591b6044820152606401610821565b60408051639aee26f160e01b81529085013560048201525f903090639aee26f1906024015f60405180830381865afa15801561103b573d5f5f3e3d5ffd5b505050506040513d5f823e601f3d908101601f191682016040526110629190810190614e9b565b5090505f6110b06040870180359061107d9060208a01614db3565b6110976110926101608b016101408c01614cdd565b612a75565b60c086015130906106ff6101e08d016101c08e01614440565b509050806111005760405162461bcd60e51b815260206004820152601c60248201527f7075626c69636174696f6e5f636f6e73656e745f696e616374697665000000006044820152606401610821565b6111126101e087016101c08801614440565b6001600160401b031661112d61020088016101e08901614440565b6001600160401b03161015801561115e57504261115261020088016101e08901614440565b6001600160401b031611155b6111995760405162461bcd60e51b815260206004820152600c60248201526b696e76616c69645f74696d6560a01b6044820152606401610821565b8535158015906111c157505f6111b56040880160208901614db3565b6001600160a01b031614155b80156111e557505f6111d960a0880160808901614db3565b6001600160a01b031614155b80156111f45750606086013515155b8015611223575060a08601357f0000000000000000000000000000000000000000000000000000000000000000145b8015611232575060c086013515155b8015611241575060e086013515155b8015611251575061018086013515155b61128f5760405162461bcd60e51b815260206004820152600f60248201526e1a5b9d985b1a5917d8dbdb9d195e1d608a1b6044820152606401610821565b6112b96112a461016088016101408901614cdd565b61069c6104ab6102008a016101e08b01614440565b866101a00135146112fb5760405162461bcd60e51b815260206004820152600c60248201526b77726f6e675f706f6c69637960a01b6044820152606401610821565b600161130f61022088016102008901614cdd565b60ff16101580156113355750600461132f61022088016102008901614cdd565b60ff1611155b61137b5760405162461bcd60e51b8152602060048201526017602482015276696e76616c69645f7465726d696e616c5f73746174757360481b6044820152606401610821565b6113c161139061016088016101408901614cdd565b6113a261022089016102008a01614cdd565b6113b46101408a016101208b01614cf6565b8961010001358989612c49565b6114106113d336889003880188614d1e565b86868080601f0160208091040260200160405190810160405280939291908181526020018383808284375f9201919091525088925061322c915050565b505050505050565b5f611429610b116040860186614d71565b90505f61145f8261144060c0880160a08901614440565b6114506080890160608a01614db3565b88608001358960c001356135d1565b90507f000000000000000000000000000000000000000000000000000000000000000085602001351415806114eb575060025f61149f6020880188614db3565b6001600160a01b0316815260208082019290925260409081015f9081208582529092529020546001600160401b03166114df610100870160e08801614440565b6001600160401b031614155b1561150957604051630df0f4e960e41b815260040160405180910390fd5b61151b61016086016101408701614440565b6001600160401b031661153661014087016101208801614440565b6001600160401b0316118061157f575061155861018086016101608701614440565b6001600160401b031661157361016087016101408801614440565b6001600160401b031610155b806115a357504261159861014087016101208801614440565b6001600160401b0316115b806115c857506115bb6101a086016101808701614440565b6001600160401b03164210155b8061161e575060808101516001600160401b03166115ee61014087016101208801614440565b6001600160401b03166116019190614fc8565b6116136101a087016101808801614440565b6001600160401b0316115b8061165c575061163661018086016101608701614440565b6001600160401b03166116516101a087016101808801614440565b6001600160401b0316115b806116b2575060608101516001600160401b031661168261014087016101208801614440565b6001600160401b03166116959190614fc8565b6116a761018087016101608801614440565b6001600160401b0316115b806116c357506001600160401b0342115b156116e15760405163392334ed60e01b815260040160405180910390fd5b5f6116eb8661282a565b90506117056116fd6020880188614db3565b828787613361565b61172257604051630df0f4e960e41b815260040160405180910390fd5b6117707fe902c899d5a9ec9321b98745344753935b8c6099e12aa3071331a08f719517496117536020890189614db3565b856117656101008b0160e08c01614440565b8a6101000135613500565b60405180604001604052808761178590614ff9565b8152426001600160401b03166020918201525f83815260018083526040918290208451805182546001600160a01b0319166001600160a01b03909116178255938401519181019190915590820151909190829060028201906117e7908261516b565b5060608201516003820180546001600160a01b039092166001600160a01b03199092169190911790556080820151600482015560a08201516005820180546001600160401b0392831667ffffffffffffffff199182161790915560c0840151600684015560e0840151600784018054918416918316919091179055610100840151600884015561012084015160099093018054610140860151610160870151610180909701518516600160c01b026001600160c01b03978616600160801b02979097166fffffffffffffffffffffffffffffffff918616600160401b026fffffffffffffffffffffffffffffffff199093169686169690961791909117169390931793909317909155602093840151600a90930180549390911692909116919091179055839061191990880188614db3565b6001600160a01b0316827f0115905e16cd3ec6acbf2513b9c8b4f10b338fe45c2218fdd9c8bbd8073d20ed894260405161195492919061528e565b60405180910390a4505050505050565b61196d82612a3d565b5f6119ac86868080601f0160208091040260200160405190810160405280939291908181526020018383808284375f920191909152506132b592505050565b5f8181526020819052604090208054919250906001600160401b038681169116146119ea5760405163817e79d160e01b815260040160405180910390fd5b6119fa60c0840160a085016153cd565b15611ada57611a19611a0f6020850185614db3565b846020013561372e565b1580611a2757506040830135155b80611a485750611a3d6080840160608501614440565b6001600160401b0316155b80611a695750611a5e60a0840160808501614440565b6001600160401b0316155b80611ab757505f516020615aaf5f395f51905f52821480611a9657505f516020615a8f5f395f51905f5282145b8015611ab7575030611aab6020850185614db3565b6001600160a01b031614155b15611ad55760405163029033fd60e21b815260040160405180910390fd5b611b71565b5f611ae86020850185614db3565b6001600160a01b0316141580611b015750602083013515155b80611b0f5750604083013515155b80611b315750611b256080840160608501614440565b6001600160401b031615155b80611b535750611b4760a0840160808501614440565b6001600160401b031615155b15611b715760405163029033fd60e21b815260040160405180910390fd5b80546001600160401b0316815f611b87836153e8565b91906101000a8154816001600160401b0302191690836001600160401b031602179055505082816001018181611bbd9190615415565b5050805482907f48910db3d98129803496a869d6e167acbbb4573e786ebb8cd8c4630e96bf8ad3906001600160401b0316611bfb6020870187614db3565b60208701356040880135611c1560808a0160608b01614440565b611c2560a08b0160808c01614440565b611c3560c08c0160a08d016153cd565b604080516001600160401b0398891681526001600160a01b0390971660208801528601949094526060850192909252841660808401529290921660a082015290151560c082015260e00160405180910390a250505050505050565b5f611c9961404d565b7f9e7027de04329f181932262b430964848a31faf668527c9b8b67ea9fafb095ad8152611cc96020840184614db3565b6001600160a01b03166020808301919091528301358160026020020152611cf36040840184614d71565b604051611d01929190614d0f565b6040519081900390208160036020020152611d226080840160608501614db3565b6001600160a01b0316816004602002015260808301358160056020020152611d5060c0840160a08501614440565b6001600160401b0316816006602002015260c08301358160076020020152611d7f610100840160e08501614440565b6001600160401b03168160086020020152610100830135816009602002015261012083013581600a602002015261014083013581600b602002015261016083013581600c602002015261018083013581600d60200201526101a083013581600e6020020152611df66101e084016101c08501614440565b6001600160401b031681600f6020020152611e1961020084016101e08501614440565b6001600160401b0316610200820152604051611e5890611e3d9083906020016154fc565b6040516020818303038152906040528051906020012061375f565b9392505050565b611e746108ca6101608a016101408b01614cdd565b611e7f888888612b91565b611e9161022089016102008a01614cdd565b60ff16600514158015611ea357508415155b611ee65760405162461bcd60e51b815260206004820152601460248201527334b73b30b634b22fb4b73b30b634b230ba34b7b760611b6044820152606401610821565b5f611ef6368a90038a018a614d1e565b6101c081018051919250611f0982614d4d565b63ffffffff1690525088355f9081526005602081905260408220546101e08401526101a0830152611f408a838b8b8a8a8a8e6130eb565b9050611f83828a8a8080601f0160208091040260200160405190810160405280939291908181526020018383808284375f9201919091525088925061322c915050565b60408281015183516101e08501515f8281526005602090815290859020548551928352908201528084018b90529251919284927ee007e049b1764ae63e7647bb47209e035c787abb0aa07316fb0b10c52a3f1f9181900360600190a46101c08201518251604080518a81526020810185905263ffffffff909316927fa8f9c5084b3347ffb10a51abee2ae0e710fa8f4c9d2b58eeec129a037986d0d5910160405180910390a350505050505050505050565b604080516101a0810182525f8082526020820181905260609282018390529181018290526080810182905260a0810182905260c0810182905260e0810182905261010081018290526101208101829052610140810182905261016081018290526101808101919091525f828152600160208181526040808420600a81015482516101a08101845282546001600160a01b031681529482015493850193909352600281018054919485946001600160401b0316939092859291840191906120fa906150f5565b80601f0160208091040260200160405190810160405280929190818152602001828054612126906150f5565b80156121715780601f1061214857610100808354040283529160200191612171565b820191905f5260205f20905b81548152906001019060200180831161215457829003601f168201915b505050918352505060038201546001600160a01b031660208201526004820154604082015260058201546001600160401b039081166060830152600683015460808301526007830154811660a0830152600883015460c083015260099092015480831660e0830152600160401b81048316610100830152600160801b81048316610120830152600160c01b900490911661014090910152969095509350505050565b5f7fe2c61f721e74cc9550ff2dd69ff27ea04e9b6e2a1206601b97754a6d63bdc22183836040516020016122499392919061564e565b60405160208183030381529060405280519060200120905092915050565b5f61227183612a75565b5060ff83165f90815260066020526040902080545b8015612317576001600160401b038416826122a2600184614ded565b815481106122b2576122b26154e8565b5f9182526020909120600160029092020101546001600160401b03161161230757816122df600183614ded565b815481106122ef576122ef6154e8565b905f5260205f2090600202015f015492505050610efc565b6123108161567f565b9050612286565b505f949350505050565b5f610efc7f2575c3f2a3e985f2d0dce8b2641759ef6e568a1dc4da23ca8434de93458b015f6123536020850185614db3565b60208501356123656040870187614d71565b604051612373929190614d0f565b60405190819003902061238c6080880160608901614440565b60808801356123a160c08a0160a08b01614440565b6040805160208101989098526001600160a01b0390961695870195909552606086019390935260808501919091526001600160401b0390811660a085015260c08401919091521660e082015261010001611e3d565b5f8681526001602052604081208054829190819083906001600160a01b0316612421575060016125ff565b81546001600160a01b038b811691161415806124555750888260020160405161244a9190615694565b604051809103902014155b80612470575060038201546001600160a01b03898116911614155b8061247f575086826006015414155b1561248c575060026125ff565b6124946137a5565b6124a0575060036125ff565b5f89815260208190526040902060048101546001820190600160801b900460ff1615806124df5750815460058501546001600160401b03908116911614155b806124f7575080546001600160a01b038b8116911614155b8061250a57508360040154816001015414155b80612519575088816002015414155b1561252757600492506125fc565b6125358a826001015461372e565b61254257600592506125fc565b6001600160a01b038c165f9081526002602090815260408083208e845290915290205460078501546001600160401b0390811691161461258557600692506125fc565b600a8501546001600160401b0390811690891610806125bb575060098401546001600160401b03600160401b9091048116908916105b806125ce575042886001600160401b0316115b156125dc57600792506125fc565b6009840154600160801b90046001600160401b031642106125fc57600892505b50505b5f81600881111561261257612612615705565b1481600881111561262557612625615705565b94509450505050965096945050505050565b61264081612a3d565b61264986612a75565b5060ff86165f908152600660205260409020851580159061269f5750636ae7701042106126915762015180612682636ae7701042614ded565b61268c9190614e00565b612693565b5f5b836001600160401b0316115b6126eb5760405162461bcd60e51b815260206004820152601a60248201527f61637469766174696f6e5f6e6f745f70726f73706563746976650000000000006044820152606401610821565b8054158061273757508054819061270490600190614ded565b81548110612714576127146154e8565b5f9182526020909120600160029092020101546001600160401b03908116908416115b6127835760405162461bcd60e51b815260206004820152601960248201527f61637469766174696f6e5f6e6f745f696e6372656173696e67000000000000006044820152606401610821565b6040805180820182528781526001600160401b0385811660208084019182528554600180820188555f88815292909220945160029091029094019384559051928101805467ffffffffffffffff1916939092169290921790559051879160ff8a16917f821b0534c35736f4fb0d5c3ad63a2e3ab6a449e1eaa2837901974bd8d7c3fbc691612819918a918a918a91908a90615719565b60405180910390a350505050505050565b5f61283361406c565b7fe902c899d5a9ec9321b98745344753935b8c6099e12aa3071331a08f7195174981526128636020840184614db3565b6001600160a01b0316602080830191909152830135816002602002015261288d6040840184614d71565b60405161289b929190614d0f565b60405190819003902081600360200201526128bc6080840160608501614db3565b6001600160a01b03168160046020020152608083013581600560200201526128ea60c0840160a08501614440565b6001600160401b0316816006602002015260c08301358160076020020152612919610100840160e08501614440565b6001600160401b03168160086020020152610100830135816009602002015261294a61014084016101208501614440565b6001600160401b031681600a602002015261296d61016084016101408501614440565b6001600160401b031681600b602002015261299061018084016101608501614440565b6001600160401b031681600c60200201526129b36101a084016101808501614440565b6001600160401b03166101a0820152604051611e5890611e3d90839060200161575f565b6129e081612a3d565b6040805185151581526001600160401b03851660208201529081018390526001600160a01b038616907f0644d946785d4656bb3d5b4e37ad66c67d189d23cbe37873b93724763eb9b4999060600160405180910390a25050505050565b33612a47826138d6565b60600151516001600160a01b031614612a72576040516282b42960e81b815260040160405180910390fd5b50565b5f5f1960ff831601612a9557505f516020615aaf5f395f51905f52919050565b60011960ff831601612ab557505f516020615a8f5f395f51905f52919050565b60405162461bcd60e51b8152602060048201526014602482015273756e737570706f727465645f616374697669747960601b6044820152606401610821565b612afd82612a75565b50612b07816138d6565b60600151602001516001600160a01b0316336001600160a01b0316148015612b4a5750335f90815260046020908152604080832060ff8087168552925290912054165b612b8d5760405162461bcd60e51b81526020600482015260146024820152733737ba2fb83ab13634b9b432b92fb3b930b232b960611b6044820152606401610821565b5050565b82355f9081526005602052604090205415801590612c095750612bf7612bbc36859003850185614d1e565b83838080601f0160208091040260200160405190810160405280939291908181526020018383808284375f9201919091525061221392505050565b83355f90815260056020526040902054145b612c445760405162461bcd60e51b815260206004820152600c60248201526b1cdd185b1957dc995cdd5b1d60a21b6044820152606401610821565b505050565b5f1960ff871601612c6557612c6084848484613a6e565b611410565b60ff8616600214612caf5760405162461bcd60e51b8152602060048201526014602482015273756e737570706f727465645f616374697669747960601b6044820152606401610821565b60048461ffff1610158015612cc95750600a8461ffff1611155b8015612ce25750612cdf61ffff85166003615787565b81145b612d215760405162461bcd60e51b815260206004820152601060248201526f696e76616c69645f636f76657261676560801b6044820152606401610821565b5f612d3161ffff86166002615787565b6001600160401b03811115612d4857612d486147b3565b6040519080825280601f01601f191660200182016040528015612d72576020820181803683370190505b5090505f8561ffff166001600160401b03811115612d9257612d926147b3565b604051908082528060200260200182016040528015612dbb578160200160208202803683370190505b5090505f5b8661ffff16811015613099575f612dd8826003615787565b90505f868287612de9826002614fc8565b92612df69392919061579e565b612dff916157c5565b60f01c90508015801590612e1957506107d061ffff821611155b612e5e5760405162461bcd60e51b81526020600482015260166024820152751a5b9d985b1a5917dcdbdd5c98d957dbdc991a5b985b60521b6044820152606401610821565b5f5b83811015612ed5578161ffff16858281518110612e7f57612e7f6154e8565b602002602001015161ffff1603612ecd5760405162461bcd60e51b81526020600482015260126024820152716475706c69636174655f657865726369736560701b6044820152606401610821565b600101612e60565b5080848481518110612ee957612ee96154e8565b602002602001019061ffff16908161ffff1681525050868683818110612f1157612f116154e8565b9050013560f81c60f81b85846002612f299190615787565b81518110612f3957612f396154e8565b60200101906001600160f81b03191690815f1a9053508686612f5c846001614fc8565b818110612f6b57612f6b6154e8565b9050013560f81c60f81b85846002612f839190615787565b612f8e906001614fc8565b81518110612f9e57612f9e6154e8565b60200101906001600160f81b03191690815f1a9053505f8787612fc2856002614fc8565b818110612fd157612fd16154e8565b919091013560f81c91505060018110801590612ff1575060058160ff1611155b6130355760405162461bcd60e51b8152602060048201526015602482015274696e76616c69645f73747564795f6f7574636f6d6560581b6044820152606401610821565b8a60ff16600114158061304c575060028160ff1611155b61308b5760405162461bcd60e51b815260206004820152601060248201526f696e636f6d706c6574655f737475647960801b6044820152606401610821565b505050806001019050612dc0565b508151602083012085146130e15760405162461bcd60e51b815260206004820152600f60248201526e77726f6e675f65786572636973657360881b6044820152606401610821565b5050505050505050565b5f6130fc60408a0160208b01614db3565b6001600160a01b03166131126020870187614db3565b6001600160a01b031614158061312e5750610100850135893514155b806131425750886040013585610120013514155b80613183575061315d6110926101608b016101408c01614cdd565b61316a6040870187614d71565b604051613178929190614d0f565b604051809103902014155b806131985750876101e0015185610140013514155b806131e657506131dd8888888080601f0160208091040260200160405190810160405280939291908181526020018383808284375f9201919091525061221392505050565b85610160013514155b806131f657508185610180013514155b1561321457604051630516289760e21b815260040160405180910390fd5b61321f858585613db3565b9998505050505050505050565b5f6132378484612213565b90508060055f865f015181526020019081526020015f2081905550836101c0015163ffffffff1684602001516001600160a01b0316855f01517f175f6c9a5ff8e756d1e1f7da86ba9b6115ab9c4a0b9307bd61a32710d9c8c3ee87878633896040516132a79594939291906157fd565b60405180910390a450505050565b805160208201205f516020615aaf5f395f51905f5281148015906132e657505f516020615a8f5f395f51905f528114155b801561331257507f08aaf5e7a98710f56656e185fdc1891b69e9445877f9f15cce76abafdda7ce3d8114155b801561333e57507f20f31300875c2c8cb7c66054f64a9cb6d30e921fbb93f7e80dc2282ca08fa09c8114155b1561335c5760405163af62684f60e01b815260040160405180910390fd5b919050565b5f6001600160a01b03851661337757505f6134f8565b6001600160a01b0385163b1561341557604051630b135d3f60e11b81526001600160a01b03861690631626ba7e906133b790879087908790600401615851565b602060405180830381865afa9250505080156133f0575060408051601f3d908101601f191682019092526133ed9181019061586a565b60015b6133fb57505f6134f8565b6001600160e01b031916630b135d3f60e11b1490506134f8565b6041821461342457505f6134f8565b8235602084013560408501355f1a7f7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a082118061347357508060ff16601b1415801561347357508060ff16601c14155b15613483575f93505050506134f8565b604080515f81526020810180835289905260ff83169181019190915260608101849052608081018390526001600160a01b0389169060019060a0016020604051602081039080840390855afa1580156134de573d5f5f3e3d5ffd5b505050602060405103516001600160a01b03161493505050505b949350505050565b6001600160a01b0384161580613514575080155b1561353257604051630df0f4e960e41b815260040160405180910390fd5b6040805160208082018890526001600160a01b03871682840152606082018690526001600160401b038516608083015260a08083018590528351808403909101815260c090920183528151918101919091205f81815260039092529190205460ff16156135b257604051631f6d5aef60e01b815260040160405180910390fd5b5f908152600360205260409020805460ff191660011790555050505050565b6040805160c0810182525f80825260208201819052918101829052606081018290526080810182905260a081019190915261360a6137a5565b61362757604051638154374b60e01b815260040160405180910390fd5b505f8581526020818152604091829020825160c08101845260018201546001600160a01b0316815260028201549281019290925260038101549282019290925260048201546001600160401b038082166060840152600160401b8204166080830152600160801b900460ff1615801560a0830152909190806136b6575080546001600160401b03878116911614155b806136d65750846001600160a01b0316825f01516001600160a01b031614155b806136e5575083826020015114155b806136f4575082826040015114155b806137065750613704858561372e565b155b156137245760405163029033fd60e21b815260040160405180910390fd5b5095945050505050565b5f6001600160a01b0383163b1580159061374757508115155b8015611e585750506001600160a01b039091163f1490565b5f613768610de6565b60405161190160f01b6020820152602281019190915260428101839052606201604051602081830303815290604052805190602001209050919050565b5f6137f07f00000000000000000000000000000000000000000000000000000000000000007f000000000000000000000000000000000000000000000000000000000000000061372e565b6137f957505f90565b604051635cee23db60e01b81527f000000000000000000000000000000000000000000000000000000000000000060048201527f00000000000000000000000000000000000000000000000000000000000000006001600160a01b031690635cee23db906024015f60405180830381865afa92505050801561389c57506040513d5f823e601f3d908101601f1916820160405261389991908101906159b0565b60015b6138a557505f90565b60408101516001600160401b0316158015906138d0575060608082015101516001600160a01b031630145b91505090565b6138de61408b565b6139287f00000000000000000000000000000000000000000000000000000000000000007f000000000000000000000000000000000000000000000000000000000000000061372e565b61394557604051638154374b60e01b815260040160405180910390fd5b604051635cee23db60e01b81527f000000000000000000000000000000000000000000000000000000000000000060048201527f00000000000000000000000000000000000000000000000000000000000000006001600160a01b031690635cee23db906024015f60405180830381865afa1580156139c6573d5f5f3e3d5ffd5b505050506040513d5f823e601f3d908101601f191682016040526139ed91908101906159b0565b905080604001516001600160401b03165f1480613a1a575060608082015101516001600160a01b03163014155b15613a3857604051638154374b60e01b815260040160405180910390fd5b816001600160401b031681604001516001600160401b03161461335c5760405163817e79d160e01b815260040160405180910390fd5b5f8461ffff16118015613a8757506101f461ffff851611155b8015613aa05750613a9d61ffff85166005615787565b81145b613adf5760405162461bcd60e51b815260206004820152601060248201526f696e76616c69645f636f76657261676560801b6044820152606401610821565b5f613aef61ffff86166002615787565b6001600160401b03811115613b0657613b066147b3565b6040519080825280601f01601f191660200182016040528015613b30576020820181803683370190505b5090505f5b8561ffff16811015613d64575f613b4d826005615787565b90505f858286613b5e826002614fc8565b92613b6b9392919061579e565b613b74916157c5565b60f01c9050613b84836001614fc8565b8161ffff1614613bc65760405162461bcd60e51b815260206004820152600d60248201526c34b73b30b634b22fb7b93232b960991b6044820152606401610821565b858583818110613bd857613bd86154e8565b9050013560f81c60f81b84846002613bf09190615787565b81518110613c0057613c006154e8565b60200101906001600160f81b03191690815f1a9053508585613c23846001614fc8565b818110613c3257613c326154e8565b9050013560f81c60f81b84846002613c4a9190615787565b613c55906001614fc8565b81518110613c6557613c656154e8565b60200101906001600160f81b03191690815f1a9053505f8686613c89856002614fc8565b818110613c9857613c986154e8565b919091013560f81c91505f90508787613cb2866003614fc8565b90613cbe876005614fc8565b92613ccb9392919061579e565b613cd4916157c5565b60f01c905060018260ff1610158015613cf1575060058260ff1611155b8015613d1957508160ff16600114613d0e5761ffff811615613d19565b6127108161ffff1611155b613d555760405162461bcd60e51b815260206004820152600d60248201526c696e76616c69645f677261646560981b6044820152606401610821565b50505050806001019050613b35565b50805160208201208414613dac5760405162461bcd60e51b815260206004820152600f60248201526e77726f6e675f65786572636973657360881b6044820152606401610821565b5050505050565b5f80613dc5610b116040870187614d71565b90505f613dfb82613ddc60c0890160a08a01614440565b613dec60808a0160608b01614db3565b89608001358a60c001356135d1565b90507f00000000000000000000000000000000000000000000000000000000000000008660200135141580613e48575030613e3c6080880160608901614db3565b6001600160a01b031614155b80613eaa575060025f613e5e6020890189614db3565b6001600160a01b0316815260208082019290925260409081015f9081208582529092529020546001600160401b0316613e9e610100880160e08901614440565b6001600160401b031614155b80613eb85750610100860135155b80613ec65750610120860135155b80613ed45750610140860135155b80613ee25750610160860135155b15613f0057604051630516289760e21b815260040160405180910390fd5b42613f136101e088016101c08901614440565b6001600160401b03161180613f425750613f3561020087016101e08801614440565b6001600160401b03164210155b80613f98575060808101516001600160401b0316613f686101e088016101c08901614440565b6001600160401b0316613f7b9190614fc8565b613f8d61020088016101e08901614440565b6001600160401b0316115b15613fb65760405163392334ed60e01b815260040160405180910390fd5b613fbf86611c90565b9250613fd9613fd16020880188614db3565b848787613361565b613ff657604051630df0f4e960e41b815260040160405180910390fd5b6140447f9e7027de04329f181932262b430964848a31faf668527c9b8b67ea9fafb095ad6140276020890189614db3565b846140396101008b0160e08c01614440565b8a6101a00135613500565b50509392505050565b6040518061022001604052806011906020820280368337509192915050565b604051806101c00160405280600e906020820280368337509192915050565b6040518061010001604052805f6001600160a01b031681526020015f81526020015f6001600160401b031681526020016141136040518060c001604052805f6001600160a01b031681526020015f6001600160a01b031681526020015f6001600160a01b031681526020015f6001600160a01b031681526020015f8152602001606081525090565b81525f60208083018290526040805160c081018252838152918201839052818101839052606082018390526080820183905260a082019290925291019081525f6020820181905260409091015290565b6001600160a01b0381168114612a72575f5ffd5b803561335c81614163565b803560ff8116811461335c575f5ffd5b8015158114612a72575f5ffd5b6001600160401b0381168114612a72575f5ffd5b803561335c8161419f565b5f5f5f5f608085870312156141d1575f5ffd5b84356141dc81614163565b93506141ea60208601614182565b925060408501356141fa81614192565b9150606085013561420a8161419f565b939692955090935050565b5f60208284031215614225575f5ffd5b5035919050565b5f610260828403121561423d575f5ffd5b50919050565b5f5f83601f840112614253575f5ffd5b5081356001600160401b03811115614269575f5ffd5b602083019150836020828501011115614280575f5ffd5b9250929050565b5f610200828403121561423d575f5ffd5b5f5f5f5f5f5f5f5f5f5f6103208b8d0312156142b2575f5ffd5b6142bc8c8c61422c565b99506102608b01356001600160401b038111156142d7575f5ffd5b6142e38d828e01614243565b909a509850506102808b01356001600160401b03811115614302575f5ffd5b61430e8d828e01614243565b909850965061432290506102a08c01614182565b94506102c08b01356001600160401b0381111561433d575f5ffd5b6143498d828e01614287565b9450506102e08b01356001600160401b03811115614365575f5ffd5b6143718d828e01614243565b909450925061438590506103008c016141b3565b90509295989b9194979a5092959850565b5f60c0828403121561423d575f5ffd5b5f5f5f604084860312156143b8575f5ffd5b83356001600160401b038111156143cd575f5ffd5b6143d986828701614396565b93505060208401356001600160401b038111156143f4575f5ffd5b61440086828701614243565b9497909650939450505050565b5f5f6040838503121561441e575f5ffd5b823561442981614163565b915061443760208401614182565b90509250929050565b5f60208284031215614450575f5ffd5b8135611e588161419f565b5f5f5f5f6102a0858703121561446f575f5ffd5b614479868661422c565b93506102608501356001600160401b03811115614494575f5ffd5b6144a087828801614243565b90945092505061028085013561420a8161419f565b5f6101a0828403121561423d575f5ffd5b5f5f5f604084860312156144d8575f5ffd5b83356001600160401b038111156144ed575f5ffd5b6143d9868287016144b5565b5f5f5f5f5f610120868803121561450e575f5ffd5b85356001600160401b03811115614523575f5ffd5b61452f88828901614243565b90965094505060208601356145438161419f565b925060408601356145538161419f565b91506145628760608801614396565b90509295509295909350565b5f6020828403121561457e575f5ffd5b81356001600160401b03811115614593575f5ffd5b6134f884828501614287565b5f5f5f5f5f5f5f5f610300898b0312156145b7575f5ffd5b6145c18a8a61422c565b97506102608901356001600160401b038111156145dc575f5ffd5b6145e88b828c01614243565b90985096505061028089013594506102a08901356001600160401b0381111561460f575f5ffd5b61461b8b828c01614287565b9450506102c08901356001600160401b03811115614637575f5ffd5b6146438b828c01614243565b9094509250506102e08901356146588161419f565b809150509295985092959890939650565b5f81518084528060208401602086015e5f602082860101526020601f19601f83011685010191505092915050565b604081526146b16040820184516001600160a01b03169052565b602083015160608201525f60408401516101a060808401526146d76101e0840182614669565b905060608501516146f360a08501826001600160a01b03169052565b50608085015160c084015260a08501516001600160401b03811660e08501525060c085015161010084015260e08501516001600160401b038116610120850152506101008501516101408401526101208501516001600160401b038116610160850152506101408501516001600160401b038116610180850152506101608501516001600160401b0381166101a0850152506101808501516001600160401b0381166101c08501525b506001600160401b03841660208401529050611e58565b634e487b7160e01b5f52604160045260245ffd5b60405161020081016001600160401b03811182821017156147ea576147ea6147b3565b60405290565b6040516101a081016001600160401b03811182821017156147ea576147ea6147b3565b60405160c081016001600160401b03811182821017156147ea576147ea6147b3565b60405161010081016001600160401b03811182821017156147ea576147ea6147b3565b604051601f8201601f191681016001600160401b0381118282101715614880576148806147b3565b604052919050565b5f60808284031215614898575f5ffd5b604051608081016001600160401b03811182821017156148ba576148ba6147b3565b6040528235815290508060208301356148d281614163565b602082015260408381013590820152606092830135920191909152919050565b803561ffff8116811461335c575f5ffd5b803563ffffffff8116811461335c575f5ffd5b5f6102608284031215614927575f5ffd5b61492f6147c7565b82358152905061494160208301614177565b60208201526040828101359082015261495d8360608401614888565b606082015260e0820135608082015261010082013560a082015261498461012083016148f2565b60c08201526149966101408301614182565b60e08201526149a86101608301614177565b6101008201526101808201356101208201526101a08201356101408201526149d36101c083016141b3565b6101608201526149e66101e083016141b3565b6101808201526149f96102008301614182565b6101a0820152614a0c6102208301614903565b6101c082015261024091909101356101e0820152919050565b5f6001600160401b03821115614a3d57614a3d6147b3565b50601f01601f191660200190565b5f614a5d614a5884614a25565b614858565b9050828152838383011115614a70575f5ffd5b828260208301375f602084830101529392505050565b5f5f6102808385031215614a98575f5ffd5b614aa28484614916565b91506102608301356001600160401b03811115614abd575f5ffd5b8301601f81018513614acd575f5ffd5b614adc85823560208401614a4b565b9150509250929050565b5f5f60408385031215614af7575f5ffd5b614b0083614182565b91506020830135614b108161419f565b809150509250929050565b5f60208284031215614b2b575f5ffd5b81356001600160401b03811115614b40575f5ffd5b6134f884828501614396565b5f5f60408385031215614b5d575f5ffd5b8235614b6881614163565b946020939093013593505050565b5f5f5f5f5f5f60c08789031215614b8b575f5ffd5b863595506020870135614b9d81614163565b9450604087013593506060870135614bb481614163565b92506080870135915060a0870135614bcb8161419f565b809150509295509295509295565b5f5f5f5f5f5f60a08789031215614bee575f5ffd5b614bf787614182565b95506020870135945060408701356001600160401b03811115614c18575f5ffd5b614c2489828a01614243565b9095509350506060870135614c388161419f565b91506080870135614bcb8161419f565b5f60208284031215614c58575f5ffd5b81356001600160401b03811115614c6d575f5ffd5b6134f8848285016144b5565b5f5f5f5f5f60a08688031215614c8d575f5ffd5b8535614c9881614163565b94506020860135614ca881614192565b93506040860135614cb88161419f565b9250606086013591506080860135614ccf8161419f565b809150509295509295909350565b5f60208284031215614ced575f5ffd5b611e5882614182565b5f60208284031215614d06575f5ffd5b611e58826148f2565b818382375f9101908152919050565b5f6102608284031215614d2f575f5ffd5b611e588383614916565b634e487b7160e01b5f52601160045260245ffd5b5f63ffffffff821663ffffffff8103614d6857614d68614d39565b60010192915050565b5f5f8335601e19843603018112614d86575f5ffd5b8301803591506001600160401b03821115614d9f575f5ffd5b602001915036819003821315614280575f5ffd5b5f60208284031215614dc3575f5ffd5b8135611e5881614163565b6001600160401b038181168382160190811115610efc57610efc614d39565b81810381811115610efc57610efc614d39565b5f82614e1a57634e487b7160e01b5f52601260045260245ffd5b500490565b5f60208284031215614e2f575f5ffd5b611e5882614903565b805161335c81614163565b5f82601f830112614e52575f5ffd5b8151614e60614a5882614a25565b818152846020838601011115614e74575f5ffd5b8160208501602083015e5f918101602001919091529392505050565b805161335c8161419f565b5f5f60408385031215614eac575f5ffd5b82516001600160401b03811115614ec1575f5ffd5b83016101a08186031215614ed3575f5ffd5b614edb6147f0565b614ee482614e38565b81526020828101519082015260408201516001600160401b03811115614f08575f5ffd5b614f1487828501614e43565b604083015250614f2660608301614e38565b606082015260808281015190820152614f4160a08301614e90565b60a082015260c08281015190820152614f5c60e08301614e90565b60e08201526101008281015190820152614f796101208301614e90565b610120820152614f8c6101408301614e90565b610140820152614f9f6101608301614e90565b610160820152614fb26101808301614e90565b6101808201529250614437905060208401614e90565b80820180821115610efc57610efc614d39565b5f82601f830112614fea575f5ffd5b611e5883833560208501614a4b565b5f6101a0823603121561500a575f5ffd5b6150126147f0565b61501b83614177565b81526020838101359082015260408301356001600160401b0381111561503f575f5ffd5b61504b36828601614fdb565b60408301525061505d60608401614177565b60608201526080838101359082015261507860a084016141b3565b60a082015260c0838101359082015261509360e084016141b3565b60e082015261010083810135908201526150b061012084016141b3565b6101208201526150c361014084016141b3565b6101408201526150d661016084016141b3565b6101608201526150e961018084016141b3565b61018082015292915050565b600181811c9082168061510957607f821691505b60208210810361423d57634e487b7160e01b5f52602260045260245ffd5b601f821115612c4457805f5260205f20601f840160051c8101602085101561514c5750805b601f840160051c820191505b81811015613dac575f8155600101615158565b81516001600160401b03811115615184576151846147b3565b6151988161519284546150f5565b84615127565b6020601f8211600181146151ca575f83156151b35750848201515b5f19600385901b1c1916600184901b178455613dac565b5f84815260208120601f198516915b828110156151f957878501518255602094850194600190920191016151d9565b508482101561521657868401515f19600387901b60f8161c191681555b50505050600190811b01905550565b5f5f8335601e1984360301811261523a575f5ffd5b83016020810192503590506001600160401b03811115615258575f5ffd5b803603821315614280575f5ffd5b81835281816020850137505f828201602090810191909152601f909101601f19169091010190565b604081526152af604082016152a285614177565b6001600160a01b03169052565b602083013560608201525f6152c76040850185615225565b6101a060808501526152de6101e085018284615266565b9150506152ed60608601614177565b6001600160a01b03811660a085015250608085013560c084015261531360a086016141b3565b6001600160401b03811660e08501525060c085013561010084015261533a60e086016141b3565b6001600160401b0381166101208501525061010085013561014084015261536461012086016141b3565b6001600160401b031661016084015261538061014086016141b3565b6001600160401b031661018084015261539c61016086016141b3565b6001600160401b03166101a08401526153b861018086016141b3565b6001600160401b0381166101c085015261479c565b5f602082840312156153dd575f5ffd5b8135611e5881614192565b5f6001600160401b0382166001600160401b038103614d6857614d68614d39565b5f8135610efc81614192565b813561542081614163565b81546001600160a01b0319166001600160a01b039190911617815560208201356001820155604082013560028201556003810160608301356154618161419f565b6001600160401b0381166001600160401b0319835416178255505f608084013561548a8161419f565b82546fffffffffffffffff0000000000000000191660409190911b6fffffffffffffffff00000000000000001617825550612c446154ca60a08501615409565b82805460ff60801b191691151560801b60ff60801b16919091179055565b634e487b7160e01b5f52603260045260245ffd5b610220810181835f5b6011811015615524578151835260209283019290910190600101615505565b50505092915050565b80518252602081015161554b60208401826001600160a01b03169052565b506040818101518382015260608083015180518286015260208101516001600160a01b031660808601529182015160a085015281015160c084015250608081015160e083015260a081015161010083015260c081015161ffff81166101208401525060e081015160ff8116610140840152506101008101516001600160a01b038116610160840152506101208101516101808301526101408101516101a08301526101608101516001600160401b0381166101c0840152506101808101516001600160401b0381166101e0840152506101a081015160ff8116610200840152506101c081015163ffffffff8116610220840152506101e001516102409190910152565b83815261565e602082018461552d565b6102a06102808201525f6156766102a0830184614669565b95945050505050565b5f8161568d5761568d614d39565b505f190190565b5f5f83546156a1816150f5565b6001821680156156b857600181146156cd576156fa565b60ff19831686528115158202860193506156fa565b865f5260205f205f5b838110156156f2578154888201526001909101906020016156d6565b505081860193505b509195945050505050565b634e487b7160e01b5f52602160045260245ffd5b608081525f61572c608083018789615266565b90506001600160401b038516602083015260ff841660408301526001600160401b03831660608301529695505050505050565b6101c0810181835f5b600e811015615524578151835260209283019290910190600101615768565b8082028115828204841417610efc57610efc614d39565b5f5f858511156157ac575f5ffd5b838611156157b8575f5ffd5b5050820193919092039150565b80356001600160f01b031981169060028410156157f6576001600160f01b0319600285900360031b81901b82161691505b5092915050565b615807818761552d565b6102e06102608201525f61581f6102e0830187614669565b610280830195909552506001600160a01b03929092166102a08301526001600160401b03166102c09091015292915050565b838152604060208201525f615676604083018486615266565b5f6020828403121561587a575f5ffd5b81516001600160e01b031981168114611e58575f5ffd5b5f60c082840312156158a1575f5ffd5b6158a9614813565b905081516158b681614163565b815260208201516158c681614163565b602082015260408201516158d981614163565b60408201526158ea60608301614e38565b60608201526080828101519082015260a08201516001600160401b03811115615911575f5ffd5b61591d84828501614e43565b60a08301525092915050565b5f60c08284031215615939575f5ffd5b615941614813565b9050815161594e8161419f565b8152602082015161595e8161419f565b602082015260408281015190820152606082015161597b8161419f565b6060820152608082015161598e8161419f565b608082015260a09182015191810191909152919050565b805161335c81614192565b5f602082840312156159c0575f5ffd5b81516001600160401b038111156159d5575f5ffd5b82016101a081850312156159e7575f5ffd5b6159ef614835565b6159f882614e38565b815260208281015190820152615a1060408301614e90565b604082015260608201516001600160401b03811115615a2d575f5ffd5b615a3986828501615891565b606083015250615a4b60808301614e90565b6080820152615a5d8560a08401615929565b60a0820152615a6f6101608301614e90565b60c0820152615a8161018083016159a5565b60e082015294935050505056fed15e251d47300ca955fd316e95053ab9b3c172bba3a1a9551566823f8538308a3b648b73caced5f86b3a1b77e96a57716025252ced4e227c237bd00f6c2a7b5da26469706673582212203899907ed27444dfe1add7041dd3f54d1d32be066cfbe982d2b9e132212a215f64736f6c634300081e0033" as const;
