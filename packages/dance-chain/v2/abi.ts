// Generated from actual solc ABI/AST by harness/megaeth/generate-publication-consent.ts.
export const danceVerdictsAbi = [
  {
    "type": "constructor",
    "inputs": [
      {
        "name": "deployment",
        "type": "tuple",
        "internalType": "struct DanceVerdictAuthorityV2.Deployment",
        "components": [
          {
            "name": "communityId",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "directory",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "directoryRuntimeHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "consentRegistry",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "consentRegistryRuntimeHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "posts",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "postsRuntimeHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "learnerConsentPolicyHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "reviewerConsentPolicyHash",
            "type": "bytes32",
            "internalType": "bytes32"
          }
        ]
      },
      {
        "name": "docs",
        "type": "tuple",
        "internalType": "struct DanceVerdictWireV2.Policy",
        "components": [
          {
            "name": "rulesSha256",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "termsSha256",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "rubricSha256",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "mediaPolicySha256",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "consentDisclosureSha256",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "privacySha256",
            "type": "bytes32",
            "internalType": "bytes32"
          }
        ]
      },
      {
        "name": "verifier",
        "type": "address",
        "internalType": "contract DanceCapturePolicyV2"
      },
      {
        "name": "verifierHash",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "EXECUTION_RULE",
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
    "name": "NOT_PASSED",
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
    "name": "PASS",
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
    "name": "REVIEW_WINDOW_MS",
    "inputs": [],
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
    "name": "bindIdentity",
    "inputs": [
      {
        "name": "id",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "hash",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "p",
        "type": "tuple",
        "internalType": "struct DanceVerdictWireV2.BindIdentity",
        "components": [
          {
            "name": "expectedOwnerEpoch",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "expectedConfigurationRevision",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "accountCommitment",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "wallet",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "expectedIdentityEpoch",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "sourceGroupId",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "sourceBindingGroupEpoch",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "sourceCurrentGroupEpoch",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "destinationGroupId",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "destinationGroupEpoch",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "createSingleton",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "active",
            "type": "bool",
            "internalType": "bool"
          }
        ]
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "tuple",
        "internalType": "struct DanceVerdictAuthorityV2.Receipt",
        "components": [
          {
            "name": "commandHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "operation",
            "type": "uint8",
            "internalType": "enum DanceVerdictWireV2.Operation"
          },
          {
            "name": "resourceId",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "resourceEpoch",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "committedAtSeconds",
            "type": "uint64",
            "internalType": "uint64"
          }
        ]
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "capturePolicy",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract DanceCapturePolicyV2"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "capturePolicyRuntimeHash",
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
    "name": "commandReceipts",
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
        "name": "commandHash",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "operation",
        "type": "uint8",
        "internalType": "enum DanceVerdictWireV2.Operation"
      },
      {
        "name": "resourceId",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "resourceEpoch",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "committedAtSeconds",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "commitVerdict",
    "inputs": [
      {
        "name": "id",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "hash",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "encoded",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "tuple",
        "internalType": "struct DanceVerdictAuthorityV2.Receipt",
        "components": [
          {
            "name": "commandHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "operation",
            "type": "uint8",
            "internalType": "enum DanceVerdictWireV2.Operation"
          },
          {
            "name": "resourceId",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "resourceEpoch",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "committedAtSeconds",
            "type": "uint64",
            "internalType": "uint64"
          }
        ]
      }
    ],
    "stateMutability": "nonpayable"
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
    "name": "configureOwner",
    "inputs": [
      {
        "name": "id",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "hash",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "p",
        "type": "tuple",
        "internalType": "struct DanceVerdictWireV2.ConfigureOwner",
        "components": [
          {
            "name": "expectedOwnerEpoch",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "expectedConfigurationRevision",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "expectedController",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "expectedPublisher",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "expectedConsentRegistry",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "ownerWallet",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "validFromSeconds",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "expiresAtSeconds",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "policyHash",
            "type": "bytes32",
            "internalType": "bytes32"
          }
        ]
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "tuple",
        "internalType": "struct DanceVerdictAuthorityV2.Receipt",
        "components": [
          {
            "name": "commandHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "operation",
            "type": "uint8",
            "internalType": "enum DanceVerdictWireV2.Operation"
          },
          {
            "name": "resourceId",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "resourceEpoch",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "committedAtSeconds",
            "type": "uint64",
            "internalType": "uint64"
          }
        ]
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "consentDisclosureSha256",
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
    "name": "consentRegistry",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract ICommunityPublicationConsentV1"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "consentRegistryRuntimeHash",
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
    "name": "deploymentBlock",
    "inputs": [],
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
    "name": "grantReviewer",
    "inputs": [
      {
        "name": "id",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "hash",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "p",
        "type": "tuple",
        "internalType": "struct DanceVerdictWireV2.GrantReviewer",
        "components": [
          {
            "name": "expectedOwnerEpoch",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "expectedConfigurationRevision",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "reviewerWallet",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "expectedReviewerEpoch",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "expiresAtSeconds",
            "type": "uint64",
            "internalType": "uint64"
          }
        ]
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "tuple",
        "internalType": "struct DanceVerdictAuthorityV2.Receipt",
        "components": [
          {
            "name": "commandHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "operation",
            "type": "uint8",
            "internalType": "enum DanceVerdictWireV2.Operation"
          },
          {
            "name": "resourceId",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "resourceEpoch",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "committedAtSeconds",
            "type": "uint64",
            "internalType": "uint64"
          }
        ]
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "groups",
    "inputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "epoch",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "memberCount",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "pendingRebinds",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "successor",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "active",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "identities",
    "inputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "wallet",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "epoch",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "groupId",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "groupEpoch",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "active",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "invalidateRules",
    "inputs": [
      {
        "name": "id",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "hash",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "p",
        "type": "tuple",
        "internalType": "struct DanceVerdictWireV2.InvalidateRules",
        "components": [
          {
            "name": "expectedRulesEpoch",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "expectedOwnerEpoch",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "expectedConfigurationRevision",
            "type": "uint64",
            "internalType": "uint64"
          }
        ]
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "tuple",
        "internalType": "struct DanceVerdictAuthorityV2.Receipt",
        "components": [
          {
            "name": "commandHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "operation",
            "type": "uint8",
            "internalType": "enum DanceVerdictWireV2.Operation"
          },
          {
            "name": "resourceId",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "resourceEpoch",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "committedAtSeconds",
            "type": "uint64",
            "internalType": "uint64"
          }
        ]
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "invalidateSubmission",
    "inputs": [
      {
        "name": "id",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "hash",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "p",
        "type": "tuple",
        "internalType": "struct DanceVerdictWireV2.InvalidateSubmission",
        "components": [
          {
            "name": "captureId",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "learnerWallet",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "expectedMediaEpoch",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "reason",
            "type": "uint8",
            "internalType": "uint8"
          }
        ]
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "tuple",
        "internalType": "struct DanceVerdictAuthorityV2.Receipt",
        "components": [
          {
            "name": "commandHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "operation",
            "type": "uint8",
            "internalType": "enum DanceVerdictWireV2.Operation"
          },
          {
            "name": "resourceId",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "resourceEpoch",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "committedAtSeconds",
            "type": "uint64",
            "internalType": "uint64"
          }
        ]
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "learnerConsentPolicyHash",
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
    "name": "media",
    "inputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "epoch",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "ready",
        "type": "bool",
        "internalType": "bool"
      },
      {
        "name": "invalidationReason",
        "type": "uint8",
        "internalType": "uint8"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "mediaPolicySha256",
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
    "name": "mergeGroups",
    "inputs": [
      {
        "name": "id",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "hash",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "p",
        "type": "tuple",
        "internalType": "struct DanceVerdictWireV2.MergeGroups",
        "components": [
          {
            "name": "expectedOwnerEpoch",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "expectedConfigurationRevision",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "leftGroupId",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "expectedLeftEpoch",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "rightGroupId",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "expectedRightEpoch",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "newGroupId",
            "type": "bytes32",
            "internalType": "bytes32"
          }
        ]
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "tuple",
        "internalType": "struct DanceVerdictAuthorityV2.Receipt",
        "components": [
          {
            "name": "commandHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "operation",
            "type": "uint8",
            "internalType": "enum DanceVerdictWireV2.Operation"
          },
          {
            "name": "resourceId",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "resourceEpoch",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "committedAtSeconds",
            "type": "uint64",
            "internalType": "uint64"
          }
        ]
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "ownerContext",
    "inputs": [],
    "outputs": [
      {
        "name": "epoch",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "configurationRevision",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "controller",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "wallet",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "validFromSeconds",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "expiresAtSeconds",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "posts",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract ICommunityPostsV1"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "postsRuntimeHash",
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
    "name": "privacySha256",
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
    "name": "publicityPolicyHash",
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
    "name": "recordingUsed",
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
    "name": "references",
    "inputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "epoch",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "revision",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "segmentLayoutSha256",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "active",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "registerSubmission",
    "inputs": [
      {
        "name": "id",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "hash",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "encoded",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "tuple",
        "internalType": "struct DanceVerdictAuthorityV2.Receipt",
        "components": [
          {
            "name": "commandHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "operation",
            "type": "uint8",
            "internalType": "enum DanceVerdictWireV2.Operation"
          },
          {
            "name": "resourceId",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "resourceEpoch",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "committedAtSeconds",
            "type": "uint64",
            "internalType": "uint64"
          }
        ]
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "registrationOf",
    "inputs": [
      {
        "name": "id",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "captureAbi",
        "type": "bytes",
        "internalType": "bytes"
      },
      {
        "name": "submissionAbi",
        "type": "bytes",
        "internalType": "bytes"
      },
      {
        "name": "submissionHash",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "reviewerConsentPolicyHash",
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
    "name": "reviewerRoles",
    "inputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "epoch",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "ownerEpoch",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "expiresAtSeconds",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "active",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "revokeReviewer",
    "inputs": [
      {
        "name": "id",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "hash",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "p",
        "type": "tuple",
        "internalType": "struct DanceVerdictWireV2.RevokeReviewer",
        "components": [
          {
            "name": "expectedOwnerEpoch",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "expectedConfigurationRevision",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "reviewerWallet",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "expectedReviewerEpoch",
            "type": "uint64",
            "internalType": "uint64"
          }
        ]
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "tuple",
        "internalType": "struct DanceVerdictAuthorityV2.Receipt",
        "components": [
          {
            "name": "commandHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "operation",
            "type": "uint8",
            "internalType": "enum DanceVerdictWireV2.Operation"
          },
          {
            "name": "resourceId",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "resourceEpoch",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "committedAtSeconds",
            "type": "uint64",
            "internalType": "uint64"
          }
        ]
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "rubricSha256",
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
    "name": "rulesEpoch",
    "inputs": [],
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
    "type": "function",
    "name": "rulesSha256",
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
    "name": "setReference",
    "inputs": [
      {
        "name": "id",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "hash",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "p",
        "type": "tuple",
        "internalType": "struct DanceVerdictWireV2.SetReference",
        "components": [
          {
            "name": "expectedOwnerEpoch",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "expectedConfigurationRevision",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "referenceId",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "expectedReferenceEpoch",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "revision",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "segmentLayoutSha256",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "active",
            "type": "bool",
            "internalType": "bool"
          }
        ]
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "tuple",
        "internalType": "struct DanceVerdictAuthorityV2.Receipt",
        "components": [
          {
            "name": "commandHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "operation",
            "type": "uint8",
            "internalType": "enum DanceVerdictWireV2.Operation"
          },
          {
            "name": "resourceId",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "resourceEpoch",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "committedAtSeconds",
            "type": "uint64",
            "internalType": "uint64"
          }
        ]
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "sourceHash",
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
    "name": "submissionId",
    "inputs": [
      {
        "name": "learner",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "captureId",
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
    "name": "termsSha256",
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
    "name": "verdicts",
    "inputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "commandHash",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "submissionHash",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "reviewerAccountCommitment",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "reviewerWallet",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "committedAtSeconds",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "category",
        "type": "uint8",
        "internalType": "uint8"
      },
      {
        "name": "withinFrozenOfferWindow",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "event",
    "name": "CommandAppliedV2",
    "inputs": [
      {
        "name": "caller",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "commandId",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "operation",
        "type": "uint8",
        "indexed": true,
        "internalType": "enum DanceVerdictWireV2.Operation"
      },
      {
        "name": "commandHash",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      },
      {
        "name": "resourceId",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      },
      {
        "name": "resourceEpoch",
        "type": "uint64",
        "indexed": false,
        "internalType": "uint64"
      },
      {
        "name": "committedAtSeconds",
        "type": "uint64",
        "indexed": false,
        "internalType": "uint64"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "SubmissionInvalidatedV2",
    "inputs": [
      {
        "name": "submissionId",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "commandId",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "mediaEpoch",
        "type": "uint64",
        "indexed": false,
        "internalType": "uint64"
      },
      {
        "name": "reason",
        "type": "uint8",
        "indexed": false,
        "internalType": "uint8"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "SubmissionRegisteredV2",
    "inputs": [
      {
        "name": "submissionId",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "commandId",
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
        "name": "captureHash",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      },
      {
        "name": "submissionHash",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      },
      {
        "name": "trustedSubmittedAtMs",
        "type": "uint64",
        "indexed": false,
        "internalType": "uint64"
      },
      {
        "name": "reviewDeadlineMs",
        "type": "uint64",
        "indexed": false,
        "internalType": "uint64"
      },
      {
        "name": "publicationGrantId",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      },
      {
        "name": "privateConsentHash",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
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
    "name": "VerdictCommittedV2",
    "inputs": [
      {
        "name": "submissionId",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "commandId",
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
        "name": "learnerAccountCommitment",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      },
      {
        "name": "sourceHash",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      },
      {
        "name": "verdict",
        "type": "tuple",
        "indexed": false,
        "internalType": "struct DanceVerdictsV2.Verdict",
        "components": [
          {
            "name": "commandHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "submissionHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "reviewerAccountCommitment",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "reviewerWallet",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "committedAtSeconds",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "category",
            "type": "uint8",
            "internalType": "uint8"
          },
          {
            "name": "withinFrozenOfferWindow",
            "type": "bool",
            "internalType": "bool"
          }
        ]
      },
      {
        "name": "learnerPublicationGrantId",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      },
      {
        "name": "reviewerPublicationGrantId",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
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
    "name": "CommandConflict",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidCommand",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidGroup",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidIdentity",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidReference",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidRules",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidSource",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidSubmission",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidVerdict",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidWindow",
    "inputs": []
  },
  {
    "type": "error",
    "name": "MediaUnavailable",
    "inputs": []
  },
  {
    "type": "error",
    "name": "RecordingAlreadyUsed",
    "inputs": []
  },
  {
    "type": "error",
    "name": "StaleContext",
    "inputs": []
  },
  {
    "type": "error",
    "name": "Unauthorized",
    "inputs": []
  },
  {
    "type": "error",
    "name": "VerdictAlreadyCommitted",
    "inputs": []
  }
] as const;
export const danceVerdictsBuild = {
  "schema": "pirate.publication-build/1",
  "contract": "DanceVerdictsV2",
  "compiler": "0.8.30+commit.73712a01",
  "evmVersion": "cancun",
  "optimizerRuns": 1,
  "viaIR": true,
  "abiSha256": "0x590c156d15bc5723b41032caffc64c598c13e8524ef6d32da28e2f7a0dbf980f",
  "runtimeTemplateHash": "0x0bae09a0a7f044ec77c4ee425230a87e5c050d810500720ba92a67c84e543aa6",
  "runtimeBytes": 23306,
  "immutableReferences": {
    "12764": [
      {
        "start": 1789,
        "length": 32
      },
      {
        "start": 20617,
        "length": 32
      },
      {
        "start": 20858,
        "length": 32
      },
      {
        "start": 22616,
        "length": 32
      }
    ],
    "12767": [
      {
        "start": 1072,
        "length": 32
      },
      {
        "start": 14268,
        "length": 32
      },
      {
        "start": 20779,
        "length": 32
      },
      {
        "start": 22426,
        "length": 32
      }
    ],
    "12769": [
      {
        "start": 2453,
        "length": 32
      },
      {
        "start": 14305,
        "length": 32
      },
      {
        "start": 21472,
        "length": 32
      }
    ],
    "12772": [
      {
        "start": 821,
        "length": 32
      },
      {
        "start": 14343,
        "length": 32
      },
      {
        "start": 16537,
        "length": 32
      },
      {
        "start": 22557,
        "length": 32
      },
      {
        "start": 22726,
        "length": 32
      },
      {
        "start": 22963,
        "length": 32
      },
      {
        "start": 23070,
        "length": 32
      }
    ],
    "12774": [
      {
        "start": 3225,
        "length": 32
      },
      {
        "start": 14385,
        "length": 32
      },
      {
        "start": 23024,
        "length": 32
      }
    ],
    "12777": [
      {
        "start": 1951,
        "length": 32
      },
      {
        "start": 14423,
        "length": 32
      },
      {
        "start": 22367,
        "length": 32
      },
      {
        "start": 22859,
        "length": 32
      }
    ],
    "12779": [
      {
        "start": 2051,
        "length": 32
      },
      {
        "start": 14462,
        "length": 32
      },
      {
        "start": 22920,
        "length": 32
      }
    ],
    "12781": [
      {
        "start": 1286,
        "length": 32
      },
      {
        "start": 14519,
        "length": 32
      }
    ],
    "12783": [
      {
        "start": 3281,
        "length": 32
      },
      {
        "start": 14557,
        "length": 32
      }
    ],
    "12790": [
      {
        "start": 1608,
        "length": 32
      },
      {
        "start": 14799,
        "length": 32
      }
    ],
    "12792": [
      {
        "start": 1847,
        "length": 32
      },
      {
        "start": 14596,
        "length": 32
      },
      {
        "start": 16493,
        "length": 32
      },
      {
        "start": 17195,
        "length": 32
      }
    ],
    "12794": [
      {
        "start": 2862,
        "length": 32
      },
      {
        "start": 14635,
        "length": 32
      }
    ],
    "12796": [
      {
        "start": 3167,
        "length": 32
      },
      {
        "start": 14674,
        "length": 32
      }
    ],
    "12798": [
      {
        "start": 2511,
        "length": 32
      },
      {
        "start": 14713,
        "length": 32
      }
    ],
    "12800": [
      {
        "start": 1182,
        "length": 32
      },
      {
        "start": 14752,
        "length": 32
      }
    ],
    "12802": [
      {
        "start": 2642,
        "length": 32
      }
    ],
    "12804": [
      {
        "start": 2109,
        "length": 32
      }
    ],
    "17580": [
      {
        "start": 3097,
        "length": 32
      },
      {
        "start": 20471,
        "length": 32
      }
    ],
    "17582": [
      {
        "start": 690,
        "length": 32
      },
      {
        "start": 20516,
        "length": 32
      }
    ]
  },
  "sources": {
    "contracts/dance/DanceCapturePolicyV2.sol": {
      "keccak256": "0x02229f9c88934a296bf17276948deb293d8fd85588ea6474dfe30605dcd9d6fc",
      "license": "UNLICENSED",
      "urls": [
        "bzz-raw://3d82c3c7eee6905ac9527af27dde8e11b831dbe15eb9444a2a16d06017342a0c",
        "dweb:/ipfs/QmYWQbvbHT4938uBhWxzit1E6tiqc8WVFTRtGPRAsAMz9x"
      ]
    },
    "contracts/dance/DanceVerdictAuthorityV2.sol": {
      "keccak256": "0x7d55951ebe29e1ef62cbb0007b9e0c996f923346015ea542e47e519141efe741",
      "license": "UNLICENSED",
      "urls": [
        "bzz-raw://959aeeb7fb529f43a29267bc506504b4f3a70584bc6a3b042fea94e763ed351b",
        "dweb:/ipfs/QmTDTBVSW1gJeW4YqVgX7VwPJegEQCvm9TK519mLR8pm8d"
      ]
    },
    "contracts/dance/DanceVerdictWireV2.sol": {
      "keccak256": "0x13eac1b348745fe316f0d353fff48ca21d1c40095c6e0b1125005bb9167f7920",
      "license": "UNLICENSED",
      "urls": [
        "bzz-raw://cffcaa87a0c9fa9dfdb9b000a11853fb244fd72766e779b05d91043f7c03638b",
        "dweb:/ipfs/QmWyKuh29nDNsmak9ov3vz56SvLEC4nYRJKhGt3Tmdcknt"
      ]
    },
    "contracts/dance/DanceVerdictsV2.sol": {
      "keccak256": "0xb24e322160e8fdc65769c26d86da8efa45a0ec651bf3d8c8a834426219fdd313",
      "license": "UNLICENSED",
      "urls": [
        "bzz-raw://8d9b0645602dcbaf426f6669195413b012a417190c7d81b91acba7bb88d4a8da",
        "dweb:/ipfs/QmZiJnzqBNDCjkFriR9RanrLBui4WAATD3n5n9RaTPYufr"
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
    "contracts/interfaces/community/ICommunityPostsV1.sol": {
      "keccak256": "0x4049e71f8d0ba83114549fb653b0bf2b94a183ba32fdf8a659328259ed568ba0",
      "license": "UNLICENSED",
      "urls": [
        "bzz-raw://ca8cfdb02904ecb405c7c8403876a381ea41a48f5e2b5c4564a466c915a1a365",
        "dweb:/ipfs/Qmc6CJu6377tGnZZTcVCEXicci6ZB6bPTE7uqF9FNHKMo1"
      ]
    },
    "contracts/interfaces/community/ICommunityPublicationConsentV1.sol": {
      "keccak256": "0x52db04fd45ff80203c4fbcc7904811df3d046aa67c2b35d3ae691c9f2cdf1b3f",
      "license": "UNLICENSED",
      "urls": [
        "bzz-raw://477c3c7bf22d0c32d0b9303b3412f61fe008fc2008b6b210d93bdb4ac886984b",
        "dweb:/ipfs/QmcUpa47nWDS2H6a8Y7inWYwAKUqPqxb9fmu9KR6y7v3g9"
      ]
    }
  }
} as const;
export const danceVerdictsRuntimeTemplate = "0x6080806040526004361015610012575f80fd5b5f3560e01c908163020cd8bf14610cbc5750806306f5ff1914610c8257806309319cff14610c485780630c8a447e14610c045780631456926b14610b9957806315a21b8714610b7f57806318d9373014610b515780631a224c9e14610b1757806325e7d78a14610afa57806327b5653114610ae05780632e89afaf14610a755780632fe54bd014610a3b57806330c5ed8f14610a215780633a58b2ee146109f257806340213ac8146109b8578063448a975d1461097e57806346ed6017146109015780634b13fefc146108da5780634bd8588b1461087a57806356f9afcd146108605780635a0b817e146108265780635a833829146107ec57806364591896146107ce57806367b2cf1d1461078a5780636a4384bf1461075a5780636d93b04e146102215780637d6344f1146107205780637f50861a146106e657806381638e9b1461067757806382100e3f146106335780639b7122cc14610604578063a363a267146105e2578063a97eeed614610559578063b4b9612114610529578063b855db82146104ef578063bcc0fd86146104c1578063bf646d8514610487578063c28e1de81461045f578063c41c2f241461041b578063c4ffc82e146103ee578063cc877cc71461037f578063cfbbbd9e14610364578063db89cf5b14610320578063e0ab023f146102d5578063e79b71821461029b578063ef161bcb146102265763ffa1ad7414610221575f80fd5b610e25565b34610297576020366003190112610297576004355f52600760205260a060405f2080549060ff6002600183015492015416906040519260018060401b038116845260018060401b038160401c16602085015260018060401b039060801c166040840152606083015215156080820152f35b5f80fd5b34610297575f3660031901126102975760206040517f00000000000000000000000000000000000000000000000000000000000000008152f35b34610297576020366003190112610297576004355f52600b602052606060405f205460ff6040519160018060401b0381168352818160401c161515602084015260481c166040820152f35b34610297575f366003190112610297576040517f00000000000000000000000000000000000000000000000000000000000000006001600160a01b03168152602090f35b34610297575f36600319011261029757602060405160018152f35b34610297576020366003190112610297576001600160a01b036103a0610e40565b165f526005602052608060405f205460ff6040519160018060401b038116835260018060401b038160401c16602084015260018060401b0381851c16604084015260c01c1615156060820152f35b346102975761041761040b61040236610da9565b92919091614491565b60405191829182610d5d565b0390f35b34610297575f366003190112610297576040517f00000000000000000000000000000000000000000000000000000000000000006001600160a01b03168152602090f35b34610297575f366003190112610297576004546040516001600160401b039091168152602090f35b34610297575f3660031901126102975760206040517f00000000000000000000000000000000000000000000000000000000000000008152f35b346102975760a03660031901126102975760603660431901126102975761041761040b602435600435614138565b34610297575f3660031901126102975760206040517f00000000000000000000000000000000000000000000000000000000000000008152f35b3461029757610160366003190112610297576101203660431901126102975761041761040b602435600435613b40565b34610297576040366003190112610297576001600160a01b0361057a610e40565b165f52600960205260405f206024355f5260205260a060405f2080549060ff600182015416906105be60036002830154920154926040519485526020850190610d3c565b6040838101919091526001600160401b03828116606085015291901c166080820152f35b34610297575f3660031901126102975760206105fc613793565b604051908152f35b346102975760403660031901126102975760206105fc610622610e40565b6024359061062e615059565b615407565b34610297575f366003190112610297576040517f00000000000000000000000000000000000000000000000000000000000000006001600160401b03168152602090f35b34610297576020366003190112610297576004355f52600660205260a060405f2060ff815491600260018201549101549060405193600180871b038116855260018060401b0390861c166020850152604084015260018060401b038116606084015260401c1615156080820152f35b34610297575f3660031901126102975760206040517f00000000000000000000000000000000000000000000000000000000000000008152f35b34610297575f3660031901126102975760206040517f00000000000000000000000000000000000000000000000000000000000000008152f35b34610297576101c0366003190112610297576101803660431901126102975761041761040b602435600435613100565b34610297575f366003190112610297576040517f00000000000000000000000000000000000000000000000000000000000000006001600160a01b03168152602090f35b34610297575f36600319011261029757602060405163240c84008152f35b34610297575f3660031901126102975760206040517f00000000000000000000000000000000000000000000000000000000000000008152f35b34610297575f3660031901126102975760206040517f00000000000000000000000000000000000000000000000000000000000000008152f35b346102975761041761040b61087436610d18565b91612c5d565b34610297576020366003190112610297576004355f526008602052608060405f2080549060ff6002600183015492015416906040519260018060401b038116845260018060401b039060401c166020840152604083015215156060820152f35b34610297575f3660031901126102975760206040515f516020615a755f395f51905f528152f35b34610297576020366003190112610297576004355f52600c60205260e060405f2060ff81549160018101549060036002820154910154916040519485526020850152604084015260018060a01b038116606084015260018060401b038160a01c1660808401528181851c1660a084015260e81c16151560c0820152f35b34610297575f3660031901126102975760206040517f00000000000000000000000000000000000000000000000000000000000000008152f35b34610297575f3660031901126102975760206040517f00000000000000000000000000000000000000000000000000000000000000008152f35b34610297576020366003190112610297576004355f52600d602052602060ff60405f2054166040519015158152f35b346102975761041761040b610a3536610e00565b91612759565b34610297575f3660031901126102975760206040517f00000000000000000000000000000000000000000000000000000000000000008152f35b34610297575f366003190112610297575f54600154600254600354604080516001600160401b03808716825295821c861660208201526001600160a01b0394851691810191909152928216606084015260a091821c841660808401529092169181019190915260c090f35b346102975761041761040b610af436610e00565b91612276565b346102975761041761040b610b0e36610da9565b929190916119f9565b34610297575f3660031901126102975760206040517f00000000000000000000000000000000000000000000000000000000000000008152f35b346102975760e03660031901126102975760a03660431901126102975761041761040b602435600435611567565b346102975761041761040b610b9336610d18565b916110e5565b34610297576020366003190112610297576004355f52600a602052610bec60405f206002810154610bfa610bd86001610bd185610f61565b9401610f61565b604051948594606086526060860190610cf4565b908482036020860152610cf4565b9060408301520390f35b34610297575f366003190112610297576040517f00000000000000000000000000000000000000000000000000000000000000006001600160a01b03168152602090f35b34610297575f3660031901126102975760206040517f00000000000000000000000000000000000000000000000000000000000000008152f35b34610297575f3660031901126102975760206040517f00000000000000000000000000000000000000000000000000000000000000008152f35b34610297575f366003190112610297576020907f00000000000000000000000000000000000000000000000000000000000000008152f35b805180835260209291819084018484015e5f828201840152601f01601f1916010190565b60c06003198201126102975760043591608060243592604319011261029757604490565b90600b821015610d495752565b634e487b7160e01b5f52602160045260245ffd5b919091608060a082019380518352610d7d60208201516020850190610d3c565b604081810151908401526060808201516001600160401b03908116918501919091529082015116910152565b9060606003198301126102975760043591602435916044356001600160401b0381116102975782602382011215610297576004810135926001600160401b0384116102975760248483010111610297576024019190565b610120600319820112610297576004359160e060243592604319011261029757604490565b34610297575f36600319011261029757602060405160028152f35b600435906001600160a01b038216820361029757565b35906001600160a01b038216820361029757565b90600182811c92168015610e98575b6020831014610e8457565b634e487b7160e01b5f52602260045260245ffd5b91607f1691610e79565b60a081019081106001600160401b03821117610ebd57604052565b634e487b7160e01b5f52604160045260245ffd5b608081019081106001600160401b03821117610ebd57604052565b606081019081106001600160401b03821117610ebd57604052565b60c081019081106001600160401b03821117610ebd57604052565b61010081019081106001600160401b03821117610ebd57604052565b601f909101601f19168101906001600160401b03821190821017610ebd57604052565b9060405191825f825492610f7484610e6a565b8084529360018116908115610fdf5750600114610f9b575b50610f9992500383610f3e565b565b90505f9291925260205f20905f915b818310610fc3575050906020610f99928201015f610f8c565b6020919350806001915483858901015201910190918492610faa565b905060209250610f9994915060ff191682840152151560051b8201015f610f8c565b6040519061100e82610ea2565b5f6080838281528260208201528260408201528260608201520152565b35906001600160401b038216820361029757565b356001600160401b03811681036102975790565b356001600160a01b03811681036102975790565b6001600160401b039081166001019190821161107f57565b634e487b7160e01b5f52601160045260245ffd5b8054600160401b600160801b03191660409290921b600160401b600160801b0316919091179055565b8054600160801b600160c01b03191660809290921b600160801b600160c01b0316919091179055565b6110ed611001565b506040519260208401906001600160401b036111088261102b565b16825260208101906001600160401b036111218361102b565b166040878101919091528101926001600160a01b0361113f85610e56565b166060888101919091528201966001600160401b0361115d8961102b565b1660808201526080815261117260a082610f3e565b61117a611001565b50611218611186615059565b926020845191604060018060a01b03838801511696015160405196838801945f516020615a955f395f51905f528652604089015260608801526080870152600360a08701523360c08701528960e087015260e086526111e761010087610f3e565b60405194859383850197518091895e840190838201905f8252519283915e01015f815203601f198101835282610f3e565b5190208415801561155d575b61154e57335f52600960205260405f20855f5260205260405f206040519161124b83610ea2565b81548352600360ff60018401541692611268602086019485614dc6565b60028101546040868101919091529101546001600160401b038082166060870152911c1660808401528151600b811015610d495715159081611542575b506115335751600b811015610d49576115295750906112cf6112c96112d59361103f565b9161103f565b90614e02565b9360018060a01b036060860151163314801590611510575b611502576001600160a01b0361130283611053565b165f908152600560205260409020546001600160401b03908116906113268361103f565b16036114f35761133861133d9161103f565b611067565b93516040516001600160401b039091169461135782610ed1565b6001600160401b0316808252602082019586525f6040830181815260608401918252919690916113d9916113c9906001600160a01b0361139688611053565b165f908152600560205260409020955186546001600160401b0319166001600160401b0391821617875590511685611093565b516001600160401b0316836110bc565b51815460ff60c01b191690151560c01b60ff60c01b161790556001600160a01b039061140490611053565b169161140e611001565b50611417614f6b565b6040519461142486610ea2565b82865260208601946003865260408701958187526060880193838552608089019060018060401b03168152335f52600960205260405f20875f5260205260405f208951815560018101925190600b821015610d4957835460ff90921660ff199290921691909117909255965160028201559251600393840180546001600160401b0319166001600160401b03928316178155965193969316926114c8908490611093565b6040519384526020840152604083015260608201525f516020615ab55f395f51905f5260803392a490565b63cf70683d60e01b5f5260045ffd5b6282b42960e81b5f5260045ffd5b506001600160a01b0361152283611053565b16156112ed565b9550505050505090565b636f1ff6b760e01b5f5260045ffd5b9050825114155f6112a5565b6312f269e560e01b5f5260045ffd5b5080861415611224565b90611570611001565b506040519160208301916044356001600160401b038116808203610297578452606435906001600160401b0382168083036102975760408701526084359160018060a01b03831695868414159283610297576060890188905260a435926001600160401b03841691828503610297578260808c015260c4359360018060401b0385169b8c8603610297578c60a082015260a0815261160f60c082610f3e565b611617611001565b506116848b6020611626615059565b94855192604060018060a01b03848901511697015160405197848901955f516020615a955f395f51905f52875260408a015260608901526080880152600260a08801523360c088015260e087015260e086526111e761010087610f3e565b51902089158015611939575b61154e57335f52600960205260405f208a5f5260205260405f20604051916116b783610ea2565b81548352600360ff600184015416926116d4602086019485614dc6565b60028101546040868101919091529101546001600160401b038082166060870152911c1660808401528151600b811015610d49571515908161192d575b506115335751600b811015610d495761191e57509061172f91614e02565b9360018060a01b036060860151163314801590611914575b61150257610297575f888152600560205260409020546001600160401b0316036114f3575f916001600160401b0361177d614f6b565b1689118015906118fb575b6118ec5761179590611067565b92516001600160401b031691610297575061180c604051926117b684610ed1565b6001600160401b03908116808552602080860194855260408681019b8c526001606088019081525f8c815260059093529120955186546001600160401b03191690841617865593519099916113c9911685611093565b51815460ff60c01b191690151560c01b60ff60c01b161790555061182e611001565b50611837614f6b565b6040519461184486610ea2565b82865260208601946002865260408701958187526060880193838552608089019060018060401b03168152335f52600960205260405f20875f5260205260405f208951815560018101925190600b821015610d4957835460ff191660ff929092169190911790925596516002808301919091559351600390910180546001600160401b039283166001600160401b0319909116178155965193969316926114c8908490611093565b63392334ed60e01b5f5260045ffd5b5060a08401515f93506001600160401b03168911611788565b50505f8815611747565b9a505050505050505050505090565b9050825114155f611711565b5080891415611690565b6001600160401b038111610ebd57601f01601f191660200190565b92919261196a82611943565b916119786040519384610f3e565b829481845281830111610297578281602093845f960137010152565b51906001600160a01b038216820361029757565b51906001600160401b038216820361029757565b908060209392818452848401375f828201840152601f01601f1916010190565b805460ff60401b191691151560401b60ff60401b16919091179055565b9092611a03611001565b506106c0810361154e57611a1836828561195e565b611a20611001565b50611a29615059565b90611ac28251604060018060a01b036020860151169401516040519460208601925f516020615a955f395f51905f528452604087015260608601526080850152600760a08501523360c08501528560e085015260e08452611a8c61010085610f3e565b60208060405194859382850197518091895e8401908282015f8152815193849201905e01015f815203601f198101835282610f3e565b5190208215801561225f575b61154e57335f52600960205260405f20835f5260205260405f2060405191611af583610ea2565b81548352600360ff60018401541692611b12602086019485614dc6565b60028101546040868101919091529101546001600160401b038082166060870152911c1660808401528151600b811015610d495715159081612253575b506115335751600b811015610d495761224b5750608083828101031261029757611b788361102b565b90611b856020850161102b565b91611bb1611b956040870161102b565b611bab85611ba560608a0161102b565b94614f94565b50614fc9565b6001600160401b0316612173576001600160a01b03611bce614ff5565b1693610120604051809663530d197160e01b8252602060048301528180611bf96024820188886119bc565b03915afa948515612240575f95612182575b50602085015194855f52600b60205260018060401b0360405f205416612173576080810180515f52600d60205260ff60405f20541661216457515f52600d60205260405f20600160ff198254161790556104a083811161029757506106a092610540908411610297578083019303606082015193611cc460018060401b0360a0850151169160018060401b0360c08601511693611cbb60405197611cae89610ea2565b610420608036920161195e565b8752369161195e565b9460208501958652604085015260608401526080830152855f52600a60205260405f2092825180519060018060401b038211610ebd578190611d068754610e6a565b601f8111612114575b50602090601f83116001146120b1575f926120a6575b50508160011b915f199060031b1c19161784555b518051939092906001600160401b038511610ebd5786948894611d5f6001840154610e6a565b601f8111612046575b50602090601f8311600114611fbe575f516020615a555f395f51905f52959383611de79460e097946003945f92611fb3575b50505f1982851b1c1916600191821b17908201555b604083015160028201556060830151910180546001600160401b0319166001600160401b039283161781556080909201511690611093565b604051611df381610eec565b600180825260208083019182525f6040808501828152898352600b9093529020925183546001600160401b0319166001600160401b03919091161783559051611e3e901515836119dc565b5181549060ff60481b9060481b169060ff60481b191617905560018060a01b038151169560408201519160608101519060018060401b0360a08201511660018060401b0360c083015116906101008784015193015193604051968752602087015260408601526060850152608084015260a083015260018060401b031660c0820152a4611ec9611001565b50611ed2614f6b565b9260405193611ee085610ea2565b8185526020850193600785526040860194818652606087019260018452608088019060018060401b03168152335f52600960205260405f20865f5260205260405f208851815560018101925190600b821015610d4957835460ff191660ff9290921691909117909255955160028201559151600390920180546001600160401b039384166001600160401b03199091161781559451600795921691611f86908390611093565b60405192835260208301526001604083015260608201525f516020615ab55f395f51905f5260803392a490565b015190505f80611d9a565b90600184015f52805f20915f5b601f198516811061202857509360018460e097946003945f516020615a555f395f51905f529a98611de798601f19811610612011575b505050811b016001820155611daf565b01515f1983871b60f8161c191690555f8080612001565b8282015184558b99508c985060019093019260209283019201611fcb565b9193955091939550600184015f5260205f20601f840160051c8101916020851061209c575b918997959391601f8c9896940160051c01905b81811061208b5750611d68565b5f81558a98508b975060010161207e565b909150819061206b565b015190505f80611d25565b5f8881528281209350601f198516905b8181106120fc57509084600195949392106120e4575b505050811b018455611d39565b01515f1960f88460031b161c191690555f80806120d7565b929360206001819287860151815501950193016120c1565b909150865f5260205f20601f840160051c8101916020851061215a575b90601f859493920160051c01905b81811061214c5750611d0f565b5f815584935060010161213f565b9091508190612131565b63c02958bd60e01b5f5260045ffd5b630f0702a760e21b5f5260045ffd5b909450610120813d8211612238575b8161219f6101209383610f3e565b8101031261029757604051906101208201906001600160401b03821183831017610ebd57610100916040526121d381611994565b83526020810151602084015260408101516040840152606081015160608401526080810151608084015261220960a082016119a8565b60a084015261221a60c082016119a8565b60c084015260e081015160e08401520151610100820152935f611c0b565b3d9150612191565b6040513d5f823e3d90fd5b935050505090565b9050825114155f611b4f565b5080851415611ace565b3580151581036102975790565b919091612281611001565b5060405192602084016001600160401b0361229b8561102b565b16815260208401936001600160401b036122b48661102b565b166040870152604081013594856060880152606082019060018060401b036122db8361102b565b166080898101919091528301926001600160401b036122f98561102b565b1660a08a015260a0810135948560c08b015260c08201998a35801515810361029757151560e082015260e0815261233261010082610f3e565b61233a611001565b506123a7612346615059565b926020845191604060018060a01b03838801511696015160405196838801945f516020615a955f395f51905f528652604089015260608801526080870152600660a08701523360c08701528c60e087015260e086526111e761010087610f3e565b51902087158015612737575b61154e57335f52600960205260405f20885f5260205260405f20604051916123da83610ea2565b81548352600360ff600184015416926123f7602086019485614dc6565b60028101546040868101919091529101546001600160401b038082166060870152911c1660808401528151600b811015610d49571515908161272b575b506115335751600b811015610d495761271e5750906124586112c961245e9361103f565b90614f94565b50855f52600860205260405f206040519161247883610ed1565b81546001600160401b03808216808652604092831c90911660208601908152600185015492860192835260029094015460ff161515606086019081529193928a1591908215612715575b82156126fa575b82156126db575b505061269a576124df8a612269565b156126b557506124ee8461103f565b81516001600160401b03908116911611155b61269a5761250d8461103f565b90516001600160401b0391821691161490816126a9575b5061269a57516125d792600291612557906125519061254b906001600160401b0316611067565b9461103f565b98612269565b906125bb6040519461256886610ed1565b6001600160401b039081168087529a811660208088019182526040888101958652951515606089019081525f8d81526008909252959020965187546001600160401b031916908316178755511685611093565b51600184015551151591019060ff801983541691151516179055565b6125df611001565b506125e8614f6b565b604051946125f586610ea2565b82865260208601946006865260408701958187526060880193838552608089019060018060401b03168152335f52600960205260405f20875f5260205260405f208951815560018101925190600b821015610d4957835460ff191660ff9290921691909117909255965160028201559251600390930180546001600160401b039485166001600160401b031990911617815595516006969316926114c8908490611093565b632fa0ffc960e11b5f5260045ffd5b9050518314155f612524565b51158061250057506126c68461103f565b81516001600160401b03908116911610612500565b9091506001600160401b03906126f09061103f565b1614155f806124d0565b91506001600160401b0361270d8861103f565b1615916124c9565b881592506124c2565b9850505050505050505090565b9050825114155f612434565b50808714156123b3565b6001600160401b0390811690811461107f5760010190565b919091612764611001565b506040519160208301906001600160401b0361277f8261102b565b168252602081016001600160401b036127978261102b565b166040860152604082013592836060870152606083019160018060401b036127be8461102b565b1660808801526080840135938460a089015260a081019260018060401b036127e58561102b565b1660c08a015260c0820135988960e082015260e0815261280761010082610f3e565b61280f611001565b5061287c61281b615059565b926020845191604060018060a01b03838801511696015160405196838801945f516020615a955f395f51905f528652604089015260608801526080870152600560a08701523360c08701528c60e087015260e086526111e761010087610f3e565b51902087158015612c37575b61154e57335f52600960205260405f20885f5260205260405f20604051916128af83610ea2565b81548352600360ff600184015416926128cc602086019485614dc6565b60028101546040868101919091529101546001600160401b038082166060870152911c1660808401528151600b811015610d495715159081612c2b575b506115335751600b811015610d495761271e5750906124586112c961292d9361103f565b505f84815260076020526040808220858352912094909314918215612c1b575b8215612c0b575b8215612be6575b508115612bc4575b508015612bae575b8015612b98575b8015612b90575b8015612b71575b612b625780548254604082811c6001600160401b039081169290911c811691909101929190831161107f5760028201805460ff19169055612a9d938692600192849184916001600160401b03906129d8908216612741565b16828060401b031982541617815501556002810160ff198154169055818060401b03612a0b838060401b03835416612741565b16828060401b03198254161781550155600260405191612a2a83610ea2565b60018084525f60208086018281526001600160401b0394851660408089019182526060890185815260808a019687528c86526007909452909320965187546001600160401b03191690861617875551929390926125bb9291612a8d911687611093565b516001600160401b0316856110bc565b612aa5611001565b50612aae614f6b565b9260405193612abc85610ea2565b8185526020850193600585526040860194818652606087019260018452608088019060018060401b03168152335f52600960205260405f20865f5260205260405f208851815560018101925190600b821015610d4957835460ff191660ff9290921691909117909255955160028201559151600390920180546001600160401b039384166001600160401b03199091161781559451600595921691611f86908390611093565b63036c503960e61b5f5260045ffd5b505f848152600760205260409020546001600160401b03161515612980565b508315612979565b50815460801c6001600160401b03161515612972565b50805460801c6001600160401b0316151561296b565b83546001600160401b03908116925090612bdd9061103f565b1614155f612963565b83549192506001600160401b039182169190612c019061103f565b161415905f61295b565b600285015460ff16159250612954565b600284015460ff1615925061294d565b9050825114155f612909565b50808a1415612888565b359060ff8216820361029757565b3560ff811681036102975790565b919091612c68611001565b50612c71615059565b60405183356020808301828152929693908601926001600160a01b03612c9685610e56565b1660408901526060604088019760018060401b03612cb38a61102b565b16828b0152019760ff612cc58a612c41565b16608082015260808152612cda60a082610f3e565b612ce2611001565b50612d4f612cee615059565b926020845191604060018060a01b03838801511696015160405196838801945f516020615a955f395f51905f528652604089015260608801526080870152600960a08701523360c08701528a60e087015260e086526111e761010087610f3e565b519020851580156130cd575b61154e57335f52600960205260405f20865f5260205260405f2060405191612d8283610ea2565b81548352600360ff60018401541692612d9f602086019485614dc6565b60028101546040868101919091529101546001600160401b038082166060870152911c1660808401528151600b811015610d4957151590816130c1575b506115335751600b811015610d49576130b657506001600160a01b03612e0184611053565b161580156130ae575b801561309b575b8015613086575b613077576001600160a01b03612e2d84611053565b1633141580613055575b61150257612e47612e4d93611053565b90615407565b92835f52600b60205260405f209060405191612e6883610eec565b546001600160401b03808216808552604083811c60ff908116158015602089015260489590951c169086015292612e9e9061103f565b1682149182159261303b575b505061217357837f639e534d96c349e9c281204df59142831b987fff11e78b21917541a942599ff26040612f69612eea8795600180851b03905116611067565b98612ef481612c4f565b99835190612f0182610eec565b5f196001861b019081168083525f602080850182815260ff909f168589019081528a8352600b909152908790209351845484191693169290921783559b51612f4b901515836119dc565b51815460ff60481b191660489190911b60ff60481b16179055612c4f565b60ff8251918a8352166020820152a3612f80611001565b50612f89614f6b565b60405194612f9686610ea2565b82865260208601946009865260408701958187526060880193838552608089019060018060401b03168152335f52600960205260405f20875f5260205260405f208951815560018101925190600b821015610d4957835460ff191660ff9290921691909117909255965160028201559251600390930180546001600160401b039485166001600160401b031990911617815595516009969316926114c8908490611093565b151591508161304d575b505f80612eaa565b90505f613045565b506001600160a01b036020606061306a615120565b0151015116331415612e37565b633e55b3b960e21b5f5260045ffd5b50600560ff61309489612c4f565b1611612e18565b5060ff6130a788612c4f565b1615612e11565b508115612e0a565b965050505050505090565b9050825114155f612ddc565b5080851415612d5b565b8054600160a01b600160e01b03191660a09290921b600160a01b600160e01b0316919091179055565b613108611001565b5060405160443591906001600160401b0383168084036102975760208201526064356001600160401b038116808203610297576040830152608435606083015260a4356001600160a01b0381168114159490929085610297576001600160a01b038416608083015260c435926001600160401b0384168403610297576001600160401b0384811660a085015260e43560c0850152610104359081168103610297576001600160401b0381811660e086015261012435919082168203610297576001600160401b038281166101008701526101443561012087015261016435939084168403610297576001600160401b03841661014087015261018435948515158603610297578515156101608801526101a43596871515880361029757871515610180820152610180815261323f6101a082610f3e565b613247611001565b50613250615059565b906132b38251604060018060a01b036020860151169401516040519460208601925f516020615a955f395f51905f528452604087015260608601526080850152600460a08501523360c08501528d60e085015260e08452611a8c61010085610f3e565b5190208a158015613789575b61154e57335f52600960205260405f208b5f5260205260405f20604051916132e683610ea2565b81548352600360ff60018401541692613303602086019485614dc6565b60028101546040868101919091529101546001600160401b038082166060870152911c1660808401528151600b811015610d49571515908161377d575b506115335751600b811015610d495761376d57509061335e91614f94565b506084355f52600660205260405f209560843515908115613758575b811561373c575b5061362b578554839060a01c6001600160401b03166137205750831593613714575b8315613701575b5082156136ee575b5081156136db575b50801561365d575b801561363a575b61362b576134756001926134636040516133e281610ea2565b85815260208082018781525f604080850182815260608601838152608087018c8152610144358552600790965291909220945185546001600160401b0319166001600160401b039182161786559251600294939192613448929091612a8d911687611093565b518884015551151591019060ff801983541691151516179055565b5460a01c6001600160401b0316611067565b9461029757604051613537936002919061348e82610ea2565b6001600160a01b0390811682526001600160401b039788166020808401828152610144356040808701918252988c1660608701908152971515608087019081526084355f908152600690945298909220945185546001600160a01b0319169416939093178455915190989495946135069116836130d7565b5160018201559251920180546001600160401b0319166001600160401b0393909316929092178255511515906119dc565b61353f611001565b50613548614f6b565b926040519361355685610ea2565b818552602085019360048552604086019460843586526060870192828452608088019060018060401b03168152335f52600960205260405f20865f5260205260405f208851815560018101925190600b821015610d4957835460ff191660ff9290921691909117909255955160028201559151600390920180546001600160401b039384166001600160401b031990911617815594516004959216916135fd908390611093565b6040519283526084356020840152604083015260608201525f516020615ab55f395f51905f5260803392a490565b63178423dd60e01b5f5260045ffd5b50610144355f908152600760205260409020546001600160401b031615156133c9565b50613666615059565b805190604060018060a01b036020830151169101516040519160208301937f5ae99d9a9108cd2930897d84e0c83a13c2d0bd002de4ac4101c831a779f2fdd3855260408401526060830152608082015260843560a082015260a081526136cd60c082610f3e565b5190206101443514156133c2565b6001600160401b0316151590505f6133ba565b6001600160401b0316151591505f6133b2565b6001600160401b0316151592505f6133aa565b60e435151593506133a3565b956134759450809350613737925060449150615495565b613463565b875460a01c6001600160401b039081169116141590505f613381565b5f9a506001600160a01b03891615915061337a565b9b50505050505050505050505090565b9050825114155f613340565b50808d14156132bf565b60405161020081016001600160401b03811182821017610ebd5760409081526001600160a01b037f0000000000000000000000000000000000000000000000000000000000000000811683527f000000000000000000000000000000000000000000000000000000000000000060208401527f00000000000000000000000000000000000000000000000000000000000000008116918301919091527f000000000000000000000000000000000000000000000000000000000000000060608301527f00000000000000000000000000000000000000000000000000000000000000001660808201527f000000000000000000000000000000000000000000000000000000000000000060a08201525f516020615a755f395f51905f5260c08201527f000000000000000000000000000000000000000000000000000000000000000060e08201527f00000000000000000000000000000000000000000000000000000000000000006101008201527f00000000000000000000000000000000000000000000000000000000000000006101208201527f00000000000000000000000000000000000000000000000000000000000000006101408201527f00000000000000000000000000000000000000000000000000000000000000006101608201527f00000000000000000000000000000000000000000000000000000000000000006101808201527f00000000000000000000000000000000000000000000000000000000000000006101a08201526001600160401b037f0000000000000000000000000000000000000000000000000000000000000000166101c0820152303f6101e080830191909152613a09615059565b91825192604060018060a01b0360208301511691015190604051947ff938fcfd72fb3fc0b194a610f74663cdd453bf40db784b06b11125cd50802db7602087015260408601526060850152608084015260018060a01b0381511660a0840152602081015160c084015260018060a01b0360408201511660e0840152606081015161010084015260018060a01b0360808201511661012084015260a081015161014084015260c081015161016084015260e08101516101808401526101008101516101a08401526101208101516101c0840152610140810151828401526101608101516102008401526101808101516102208401526101a081015161024084015260018060401b036101c08201511661026084015201516102808201526102808152613b366102a082610f3e565b6020815191012090565b613b48611001565b50604051604435929091906001600160401b0384168403610297576001600160401b0384811660208501526064359081168103610297576001600160401b0381166040850152608435906001600160a01b0382168203610297576001600160a01b03828116606087015260a435969087168703610297576001600160a01b03878116608088015260c435939084168403610297576001600160a01b0384811660a089015260e435979088168814159283610297576001600160a01b03891660c083015261010435946001600160401b0386168603610297576001600160401b0386811660e085015261012435979088168814159384610297576001600160401b03891661010082015261014435610120808301919091528152613c6d61014082610f3e565b613c75611001565b50613c7e615059565b90613ce18251604060018060a01b036020860151169401516040519460208601925f516020615a955f395f51905f528452604087015260608601526080850152600160a08501523360c08501528d60e085015260e08452611a8c61010085610f3e565b5190208a15801561412e575b61154e57335f52600960205260405f208b5f5260205260405f2060405191613d1483610ea2565b81548352600360ff60018401541692613d31602086019485614dc6565b60028101546040868101919091529101546001600160401b038082166060870152911c1660808401528151600b811015610d495715159081614122575b506115335751600b811015610d495761376d5750613d8a6156ef565b9b60608d019560018060a01b03875151163303611502575f546001600160401b0386811691161480159490614106575b5083156140ec575b5082156140cf575b508115614097575b50801561406a575b8015614056575b6114f3575f906001600160401b03861615801561403a575b8015614012575b8015613ff5575b6118ec57613e16604091611067565b9a01519251516001600160a01b03169361029757610297576102975760405197613e3f89610f07565b6001600160401b03908116808a5282821660208b015260408a81018590526001600160a01b038a1660608c0181905286841660808d01529690921660a09a8b018190525f80546001600160801b03191683179490931b600160401b600160801b031693909317909155600180546001600160a01b031916909317909255600280546001600160e01b0319169094179290971b600160a01b600160e01b031691909117909155600380546001600160401b031916909517909455613f00611001565b50613f09614f6b565b60405194613f1686610ea2565b828652602086019460018652604087019560018060a01b03821687526060880193838552608089019060018060401b03168152335f52600960205260405f20875f5260205260405f208951815560018101925190600b821015610d4957835460ff191660ff9290921691909117909255965160028201559251600390930180546001600160401b039485166001600160401b03199091161781559551600196931692613fc3908490611093565b604051938452858060a01b03166020840152604083015260608201525f516020615ab55f395f51905f5260803392a490565b50826102975765083126e978d46001600160401b03881611613e07565b5082610297576001600160401b03614028614f6b565b166001600160401b0388161115613e00565b505f92508291506001600160401b038781169087161015613df9565b505f93506001600160a01b03891615613de1565b507f0000000000000000000000000000000000000000000000000000000000000000610144351415613dda565b7f00000000000000000000000000000000000000000000000000000000000000006001600160a01b039081169116141590505f613dd2565b8551602001516001600160a01b039182169116141591505f613dca565b8651516001600160a01b039182169116141592505f613dc2565b60408f01516001600160401b039182169116141593505f613dba565b9050825114155f613d6e565b50808a1415613ced565b614140611001565b506040516044356001600160401b038116916020810183830361029757838152606435916001600160401b038316918284141591826102975760408101849052608435916001600160401b0383169182840361029757826060820152606081526141ab608082610f3e565b6141b3611001565b506142206141bf615059565b926020845191604060018060a01b03838801511696015160405196838801945f516020615a955f395f51905f528652604089015260608801526080870152600a60a08701523360c08701528d60e087015260e086526111e761010087610f3e565b51902088158015614487575b61154e57335f52600960205260405f20895f5260205260405f206040519161425383610ea2565b81548352600360ff60018401541692614270602086019485614dc6565b60028101546040868101919091529101546001600160401b038082166060870152911c1660808401528151600b811015610d49571515908161447b575b506115335751600b811015610d495761271e57506142c9615120565b9060018060401b03604083015116036114f3576060015151336001600160a01b039091160361444c5750610297578015159182614433575b50506114f3575b501580159061441f575b61441057600480546001600160401b03191660011790557f000000000000000000000000000000000000000000000000000000000000000090614353611001565b5061435c614f6b565b926040519361436a85610ea2565b8185526020850193600a85526040860194818652606087019260018452608088019060018060401b03168152335f52600960205260405f20865f5260205260405f208851815560018101925190600b821015610d4957835460ff191660ff9290921691909117909255955160028201559151600390920180546001600160401b039384166001600160401b03199091161781559451600a95921691611f86908390611093565b6319557f1960e31b5f5260045ffd5b506004546001600160401b03161515614312565b505f80546001600160401b031690911415915080614301565b6001600160a01b0393606093506144639250614e02565b015116330315614308576282b42960e81b5f5260045ffd5b9050825114155f6142ad565b50808a141561422c565b909261449b611001565b506101e0810361154e576101e08382810103126102975760405190602082016001600160401b03811183821017610ebd576040819052916101e083016001600160401b03811184821017610ebd57604052843583526144fc60208601612c41565b60208401526040850135604084015261451760608601610e56565b60608401528260808101916080870135835261453560a0880161102b565b60a083015260c087013560c083015261455060e0880161102b565b60e0830152614562610100880161102b565b610100830152614575610120880161102b565b610120830152614588610140880161102b565b61014083015261459b610160880161102b565b6101608301526145ae610180880161102b565b6101808301526145c16101a0880161102b565b6101a08301526101c08701356101c0830152526145df36838761195e565b6145e7611001565b506145f0615059565b906146538251604060018060a01b036020860151169401516040519460208601925f516020615a955f395f51905f528452604087015260608601526080850152600860a08501523360c08501528760e085015260e08452611a8c61010085610f3e565b51902084158015614dbc575b61154e57335f52600960205260405f20855f5260205260405f206040519161468683610ea2565b81548352600360ff600184015416926146a3602086019485614dc6565b60028101546040868101919091529101546001600160401b038082166060870152911c1660808401528151600b811015610d495715159081614db0575b506115335751600b811015610d49576115295750610100830151610180840151614716916001600160401b039182169116614f94565b6101a0840151909190614731906001600160401b0316614fc9565b83515f52600a60205260405f209584515f52600b60205260405f209660206040519861475c8a610eec565b5460018060401b03811690818b5260ff808260401c1615918c8315958691015260481c1660408c015291614d97575b506121735785515f52600c60205260ff600360405f20015460e01c16614d885760ff60208701511660018114159081614d7c575b50614d6d576001600160401b036147d4614f6b565b16946103e886026001600160401b0381169590860361107f5761016088015160038401546001600160401b0381811692169182109188908315614d63575b50508115614d4c575b506118ec57606088810151908201516001600160a01b0391821691168103614c87575061012088015190516001600160401b039182169116036114f3575b6001600160a01b03614869614ff5565b169060405193849163152ae66760e21b8352604060048401525f91855461488f81610e6a565b908160448701526001811690815f14614c635750600114614c25575b506148c860c09593859384936003198584030160248601526119bc565b03915afa918215612240575f92614b98575b50600201549360408601519260018060a01b036060880151169260ff60208901511693600185149687614b80575b87614b69575b5060405160e08101979093906001600160401b038911858a1017610ebd5760ff7f056ed66091d100ce36e7e3a24a4d575901b8c8df869559cff417f15171628179978f978d958f9c996101809a6040528952600360208a019e8f90815260408b019d8e5260608b0192835260808b0193845260a08b0194855260c08b01961515875288515f52600c60205260405f20908b5182555160018201558d5160028201550160018060a01b0360018060a01b038351161660018060a01b03198254161781556149e360018060401b03845116826130d7565b835181548660e81b8851151560e81b16918760e01b9060e01b169061ffff60e01b19161717905586519b60018060a01b038951169e60208a01519a60a0614a28613793565b9b01519851998d60018060401b03910151169a6040519c8d5260208d01525160408c01525160608b01525160808a015260018060a01b0390511660a089015260018060401b0390511660c0880152511660e0860152511515610100850152610120840152610140830152610160820152a45191516001600160401b031692614aae611001565b50614ab7614f6b565b60405194614ac486610ea2565b82865260208601946008865260408701958187526060880193838552608089019060018060401b03168152335f52600960205260405f20875f5260205260405f208951815560018101925190600b821015610d4957835460ff191660ff9290921691909117909255965160028201559251600390930180546001600160401b039485166001600160401b031990911617815595516008969316926114c8908490611093565b60808301516001600160401b03161196505f61490e565b60608301516001600160401b03168110159750614908565b90915060c0813d60c011614c1d575b81614bb460c09383610f3e565b810103126102975760029060a060405191614bce83610f07565b614bd781611994565b83526020810151602084015260408101516040840152614bf9606082016119a8565b6060840152614c0a608082016119a8565b6080840152015160a082015291906148da565b3d9150614ba7565b5f87815260208120929450915b818310614c495750508301606401916148c86148ab565b80546064848b010152889550602090920191600101614c32565b60ff191660648088019190915291151560051b860190910193506148c890506148ab565b906060915f52600560205260405f209060405191614ca483610ed1565b549160018060401b0383169182825260018060401b038460401c169182602082015260ff60018060401b038660801c169586604084015260c01c1615908115968791015294614d37575b50508215614d1e575b508115614d13575b5015614859576282b42960e81b5f5260045ffd5b90508610155f614cff565b6101208a01516001600160401b0316141591505f614cf7565b516001600160401b0316141592505f80614cee565b60401c6001600160401b031687101590505f61481b565b119150875f614812565b637de75f3960e11b5f5260045ffd5b6002915014155f6147bf565b636ba8a76560e11b5f5260045ffd5b6101408801516001600160401b0316141590505f61478b565b9050825114155f6146e0565b508087141561465f565b600b821015610d495752565b60405190614ddf82610f07565b5f60a0838281528260208201528260408201528260608201528260808201520152565b9190614e0c614dd2565b50614e156156ef565b9260405191614e2383610f07565b5f546001600160401b038082168552604091821c8116602086019081526001546001600160a01b03908116938701938452600254908116606088015260a090811c83166080880190815260035490931690870190815295978896949293929091614e8b614f6b565b6001600160401b039097168015988915614f56575b50508715614f3e575b508615614f22575b508515614f03575b50508315614eeb575b508215614ed2575b50506114f357565b516001600160401b039081169116101590505f80614eca565b516001600160401b039081169083161092505f614ec2565b606001515190516001600160a01b039081169116141593505f80614eb9565b60408201516001600160401b039182169116141595505f614eb1565b516001600160401b038083169116141596505f614ea9565b516001600160401b0316141597505f80614ea0565b42158015614f85575b6118ec57426001600160401b031690565b5065083126e978d44211614f74565b90614f9d614dd2565b506001600160a01b0360206060614fb26156ef565b0151015116330361150257614fc691614e02565b90565b6001600160401b031615801590614fe1575b61441057565b506004546001600160401b03161515614fdb565b7f0000000000000000000000000000000000000000000000000000000000000000906001600160a01b0382163f7f00000000000000000000000000000000000000000000000000000000000000000361504a57565b638154374b60e01b5f5260045ffd5b5f6040805161506781610eec565b828152826020820152015260405161507e81610eec565b4681523060208201527f0000000000000000000000000000000000000000000000000000000000000000604082015290565b604051906150bd82610f22565b5f60e0838281528260208201528260408201526040516150dc81610f07565b838152836020820152836040820152836060820152836080820152606060a08201526060820152826080820152615111614dd2565b60a08201528260c08201520152565b6151286150b0565b507f00000000000000000000000000000000000000000000000000000000000000006001600160a01b031690813b1515806153dd575b1561504a575f60249260405193848092635cee23db60e01b82527f000000000000000000000000000000000000000000000000000000000000000060048301525afa918215612240575f926151e4575b5060408201516001600160401b0316158281156151cd575b5061504a57565b60600151516001600160a01b03161590505f6151c6565b9091503d805f833e6151f68183610f3e565b810190602081830312610297578051906001600160401b0382116102975701808203916101a08312610297576040519261522f84610f22565b61523883611994565b845260208301516020850152615250604084016119a8565b604085015260608301516001600160401b03811161029757830160c081840312610297576040519061528182610f07565b61528a81611994565b825261529860208201611994565b60208301526152a960408201611994565b60408301526152ba60608201611994565b60608301526080818101519083015260a0810151906001600160401b03821161029757019280601f850112156102975783516152f581611943565b916153036040519384610f3e565b81835260208287010111610297576020815f928260c098018386015e8301015260a08201526060850152615339608084016119a8565b6080850152609f190112610297576101809060405161535781610f07565b61536360a083016119a8565b815261537160c083016119a8565b602082015260e0820151604082015261538d61010083016119a8565b606082015261539f61012083016119a8565b608082015261014082015160a082015260a08401526153c161016082016119a8565b60c0840152015180151581036102975760e0820152905f6151ae565b507f0000000000000000000000000000000000000000000000000000000000000000823f1461515e565b9091815192604060018060a01b036020850151169301516040519360208501957f81b937bab123e78e24b1b0d279caa0c94d395aed49cc46a8c7bdb87f1720b12a875260408601526060850152608084015260018060a01b031660a083015260c082015260c0815261547a60e082610f3e565b51902090565b6001600160401b0316801561107f575f190190565b600181015490815f52600760205260405f20916154b56101408501612269565b80156156cc575b80156156be575b8015615698575b8015615675575b61362b5760ff6002840154166156105750909161010081013591825f52600760205260405f209260018501541491821592615600575b82156155d9575b82156155b0575b5050801561559b575b8015615586575b61362b578154610f999261554e916155489060401c6001600160401b0316615480565b90611093565b805461556f906155699060801c6001600160401b0316615480565b826110bc565b80546155489060401c6001600160401b0316612741565b50805460801c6001600160401b031615615525565b50815460401c6001600160401b03161561551e565b60ff9192506155c461016060029201612269565b92015460401c16151590151514155f80615515565b83549092506001600160401b03908116906155f7610120850161103f565b1614159161550e565b600284015460ff16159250615507565b610100840135149283159361564e575b508215615630575b505061362b57565b6002015490546001600160401b039081169116141590505f80615628565b61565d9193506101200161103f565b81546001600160401b0391821691161415915f615620565b5082546001600160401b039081169061569060e0870161103f565b1614156154d1565b5060028201546001600160401b03908116906156b660c0870161103f565b1614156154ca565b5060a08401358114156154c3565b5081546001600160a01b03908116906156e760608701611053565b1614156154bc565b6156f76150b0565b50615700615120565b606081015160208101519192916001600160a01b031615908115615a18575b5080156159b0575b8015615948575b80156158b0575b8015615807575b8015615749575b61504a57565b506040516331070bc960e21b81526020816004817f00000000000000000000000000000000000000000000000000000000000000006001600160a01b03165afa908115612240575f916157cd575b507f00000000000000000000000000000000000000000000000000000000000000006001600160a01b0390811691161415615743565b90506020813d6020116157ff575b816157e860209383610f3e565b81010312610297576157f990611994565b5f615797565b3d91506157db565b50604051633fa8430d60e11b81526020816004817f00000000000000000000000000000000000000000000000000000000000000006001600160a01b03165afa908115612240575f9161587e575b507f0000000000000000000000000000000000000000000000000000000000000000141561573c565b90506020813d6020116158a8575b8161589960209383610f3e565b8101031261029757515f615855565b3d915061588c565b5060405163dcdc7c1960e01b81526020816004817f00000000000000000000000000000000000000000000000000000000000000006001600160a01b03165afa908115612240575f9161590b575b5060ff1660011415615735565b90506020813d602011615940575b8161592660209383610f3e565b81010312610297575160ff811681036102975760ff6158fe565b3d9150615919565b507f00000000000000000000000000000000000000000000000000000000000000006001600160a01b0316803b15159081615985575b501561572e565b3f7f00000000000000000000000000000000000000000000000000000000000000001490505f61597e565b507f00000000000000000000000000000000000000000000000000000000000000006001600160a01b0316803b151590816159ed575b5015615727565b3f7f00000000000000000000000000000000000000000000000000000000000000001490505f6159e6565b606001517f00000000000000000000000000000000000000000000000000000000000000006001600160a01b039081169116141590505f61571f56fe37df8828f0e4ad0254c3673a7637d40f99abbdf00a41e6cc715965bd1d4938813276b5d773a2176037d52a2d7bcbfd7a0f4dfcfe4a2f9803e142f082e7a37a97e74e15b5a258078a45ca49c620c58c1d1d6d81887f78c5764bf276d0e6a202f7bff1c9529e0de1300cfe17ad3478b5ee63ea794915f494e7db83c1cd58a679c3a2646970667358221220780b6a3b00405249e489c94f2ae3e205fafd736664466c2fb25262984d74184164736f6c634300081e0033" as const;
export const danceCapturePolicyAbi = [
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
    "name": "verifyRegistration",
    "inputs": [
      {
        "name": "encoded",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "tuple",
        "internalType": "struct DanceCapturePolicyV2.RegistrationFacts",
        "components": [
          {
            "name": "learner",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "submissionId",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "captureHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "submissionHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "recordingReplayKey",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "trustedSubmittedAtMs",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "reviewDeadlineMs",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "publicationGrantId",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "privateConsentHash",
            "type": "bytes32",
            "internalType": "bytes32"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "verifyVerdictContext",
    "inputs": [
      {
        "name": "captureAbi",
        "type": "bytes",
        "internalType": "bytes"
      },
      {
        "name": "decisionAbi",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [
      {
        "name": "facts",
        "type": "tuple",
        "internalType": "struct DanceCapturePolicyV2.CaptureFacts",
        "components": [
          {
            "name": "learner",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "accountCommitment",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "groupId",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "opensAtMs",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "cutoffAtMs",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "publicationGrantId",
            "type": "bytes32",
            "internalType": "bytes32"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "error",
    "name": "AuthorizationChanged",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidCapture",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidConsent",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidIdentity",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidReference",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidSubmission",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidWindow",
    "inputs": []
  },
  {
    "type": "error",
    "name": "SelfReview",
    "inputs": []
  }
] as const;
export const danceCapturePolicyBuild = {
  "schema": "pirate.publication-build/1",
  "contract": "DanceCapturePolicyV2",
  "compiler": "0.8.30+commit.73712a01",
  "evmVersion": "cancun",
  "optimizerRuns": 1,
  "viaIR": true,
  "abiSha256": "0x30b6ecdb723341a5c800e811e8507dc9a5de87dd98b1fc58346771ec2e328823",
  "runtimeTemplateHash": "0x23e453a1cbe9e4bac29adb87dde38cc418801fe72ae1be695dc0ac15c1869570",
  "runtimeBytes": 8910,
  "immutableReferences": {},
  "sources": {
    "contracts/dance/DanceCapturePolicyV2.sol": {
      "keccak256": "0x02229f9c88934a296bf17276948deb293d8fd85588ea6474dfe30605dcd9d6fc",
      "license": "UNLICENSED",
      "urls": [
        "bzz-raw://3d82c3c7eee6905ac9527af27dde8e11b831dbe15eb9444a2a16d06017342a0c",
        "dweb:/ipfs/QmYWQbvbHT4938uBhWxzit1E6tiqc8WVFTRtGPRAsAMz9x"
      ]
    },
    "contracts/dance/DanceVerdictWireV2.sol": {
      "keccak256": "0x13eac1b348745fe316f0d353fff48ca21d1c40095c6e0b1125005bb9167f7920",
      "license": "UNLICENSED",
      "urls": [
        "bzz-raw://cffcaa87a0c9fa9dfdb9b000a11853fb244fd72766e779b05d91043f7c03638b",
        "dweb:/ipfs/QmWyKuh29nDNsmak9ov3vz56SvLEC4nYRJKhGt3Tmdcknt"
      ]
    },
    "contracts/interfaces/community/ICommunityPostsV1.sol": {
      "keccak256": "0x4049e71f8d0ba83114549fb653b0bf2b94a183ba32fdf8a659328259ed568ba0",
      "license": "UNLICENSED",
      "urls": [
        "bzz-raw://ca8cfdb02904ecb405c7c8403876a381ea41a48f5e2b5c4564a466c915a1a365",
        "dweb:/ipfs/Qmc6CJu6377tGnZZTcVCEXicci6ZB6bPTE7uqF9FNHKMo1"
      ]
    },
    "contracts/interfaces/community/ICommunityPublicationConsentV1.sol": {
      "keccak256": "0x52db04fd45ff80203c4fbcc7904811df3d046aa67c2b35d3ae691c9f2cdf1b3f",
      "license": "UNLICENSED",
      "urls": [
        "bzz-raw://477c3c7bf22d0c32d0b9303b3412f61fe008fc2008b6b210d93bdb4ac886984b",
        "dweb:/ipfs/QmcUpa47nWDS2H6a8Y7inWYwAKUqPqxb9fmu9KR6y7v3g9"
      ]
    }
  }
} as const;
export const danceCapturePolicyRuntime = "0x6080806040526004361015610012575f80fd5b5f905f3560e01c908163530d1971146106315750806354ab999c1461005d5763ffa1ad741461003f575f80fd5b3461005a578060031936011261005a57602060405160028152f35b80fd5b503461005a57604036600319011261005a576004356001600160401b03811161062d5761008e903690600401610fbc565b90916024356001600160401b03811161062d576100af903690600401610fbc565b9390916100ba611378565b50806106195750610420831480159061060d575b6105fe576100db336113a8565b92810190610420818303126104c85761010b6100fb6101e09385936110cb565b61010361143d565b90863361148a565b94810103126104c85760405190602082016001600160401b038111838210176105ea576040526040519261013e84611021565b81358452602082013560ff811681036104c8576020850152604084016040830135815261016d606084016110aa565b9260608601938452608086016080820135815261026461018f60a08401611096565b60a0890190815260c089019860c08501358a526101ae60e08601611096565b9060e081019182526101c36101008701611096565b6101008201526101d66101208701611096565b6101208201526101e96101408701611096565b6101408201526101fc6101608701611096565b9961016082019a8b526102126101808801611096565b6101808301526102256101a08801611096565b6101a08301526101c096870135968201968752528551885192518b5192516001600160401b03908116949116916001600160a01b039091169033611c40565b82519660208901978851149081156105d1575b81156105c2575b506105b35784519051865160405163db89cf5b60e01b815291926001600160401b03909116916001600160a01b0390911690602081600481335afa9081156104d4575f91610571575b5060405163020cd8bf60e01b815292602084600481335afa9384156104d4575f94610536575b5060408051636e1a895560e11b8152600481019690965260248601939093527f20f31300875c2c8cb7c66054f64a9cb6d30e921fbb93f7e80dc2282ca08fa09c604486015233606486015260848501939093526103e89092046001600160401b031660a484015290829060c49082906001600160a01b03165afa9081156104d4575f916104ee575b50156104df5751604051637d6344f160e01b81529094602082600481335afa9182156104d4575f9261049c575b50835160208086015160409687015195519751935187517fc9b8ac9a1b32d07b604b2b0849af3da3cf41a2f5009cc3e9bac9e89f05e5532f938101938452978801939093526001600160a01b039081166060880152608087019590955260a0860196909652921660c084015260e08301526001600160401b031661010080830191909152815261043461012082611073565b5190200361048d5760a060c09260405192600180841b0382511684525160208401526040810151604084015260018060401b03606082015116606084015260018060401b036080820151166080840152015160a0820152f35b630df0f4e960e41b5f5260045ffd5b9091506020813d6020116104cc575b816104b860209383611073565b810103126104c85751905f6103a2565b5f80fd5b3d91506104ab565b6040513d5f823e3d90fd5b63396e3e0b60e11b5f5260045ffd5b90506040813d60401161052e575b8161050960409383611073565b810103126104c857602061051c82611c33565b91015160ff8116036104c8575f610375565b3d91506104fc565b919350936020823d602011610569575b8161055360209383611073565b810103126104c8579051909390929060c46102ed565b3d9150610546565b90506020813d6020116105ab575b8161058c60209383611073565b810103126104c857516001600160a01b03811681036104c8575f6102c7565b3d915061057f565b633c82b95f60e11b5f5260045ffd5b9050516040890151145f61027e565b86518a516001600160a01b039081169116149150610277565b634e487b7160e01b5f52604160045260245ffd5b63e10d68f760e01b5f5260045ffd5b506101e08414156100ce565b634e487b7160e01b81526011600452602490fd5b5080fd5b346104c85760203660031901126104c857600435906001600160401b0382116104c8575f610666610100933690600401610fbc565b93909261067281610fe9565b8281528260208201528260408201528260608201528260808201528260a08201528260c08201528260e082015201526106aa6106a090565b60208101809111610e6e578203610cce576106c4336113a8565b91808201918083036106c081126104c857604051906106e282611005565b6106eb83611096565b82526106f960208401611096565b602083015261070a60408401611096565b604083015261071b60608401611096565b606083015261072e6080840195866110cb565b608083019081529160a061049f198301126104c8576040519160a08301906001600160401b038211848310176105ea57610160916040526107726104a087016110be565b84526107816104c08701611096565b60208501526104e086013560408501526105008601356060850152610520860135608085015260a0830193845261053f1901126104c857604051906101608201906001600160401b038211838310176105ea5760e0916040526105408601358352610560860135602084015261058086013560408401526105a086013560608401526105c0860135608084015261081b6105e08701611096565b60a084015261060086013560c0840152610620860135828401526108426106408701611096565b6101008401526108556106608701611096565b6101208401526108686106808701611096565b61014084015260c0810192835201966106a0850135885261088761143d565b92610895848651843361148a565b506104a0978789116104c8576108af906104203691611342565b9082519961091b602085019360018060a01b038551169c604087019d8e5190604051927f1a344c6e1edb22508737847cf689adb882c6b6e6dc4f6bb894028f19e2e8e87460208501526040840152606083015260808201526080815261091660a082611073565b611bf3565b60208151910120956105409a8b81116104c8578a8c116104c8576109498c826109a2938d0191033691611342565b8d87519060018060a01b03885116905190604051927f2e6a9124c34d3f0595fcce4035a6bf2256a4af3059c5b6c5937866b8c6624d9f60208501526040840152606083015260808201526080815261091660a082611073565b60208151910120928651938d8551908b519060018060a01b0360408301511691518a519260018060a01b038b511692516040519360208501957f81b937bab123e78e24b1b0d279caa0c94d395aed49cc46a8c7bdb87f1720b12a875260408601526060850152608084015260a083015260c082015260c08152610a2660e082611073565b51902014801590610fae575b8015610fa2575b8015610f8d575b8015610f84575b610cce57815191825115928315610f75575b8315610f60575b8315610ef7575b508215610ed6575b8215610eb5575b508115610ea6575b5061048d57610100830180516001600160401b03169190610a9e83611ec3565b15928315610e93575b8315610e82575b508215610e36575b508115610e19575b508015610dfa575b8015610dda575b610dcb5760808201518b60018060401b0360a08501511683519087519360018060a01b0388511693516040519460208601967fbf44115315a11e91df4c8455678e511fdee0a1ca7e0409bde947d980569a897b88526040870152606086015260808501528a60a085015260c084015260e08301526101008201526101008152610b5861012082611073565b5190208060608401511492831593610d58575b8315610cdd575b505050610cce5761012098610bb1610baa610c0995519860018060a01b0360408a510151169b8a519b610ba46106a090565b9261130f565b3691611342565b92519160018060a01b03905116905190604051927f3a2294aa55a7aa41ea51ce2ab6da7074087a082dd845e31ed99f65395cb689d960208501526040840152606083015260808201526080815261091660a082611073565b6020815191012060c08401519060018060401b036101008601511692604060c0600180831b038b890151169651015196015196610100604051610c4b81610fe9565b8a81526020810192835260408101938452606081019485526080810195865260a0810196875260c0810197885260e081019889520197885260405198895251602089015251604088015251606087015251608086015260018060401b0390511660a085015260018060401b0390511660c08401525160e083015251610100820152f35b633e55b3b960e21b5f5260045ffd5b60e0919293500151915184519160018060a01b03855116918d516040519360208501957f573643a975393215e6185dda9c340257a184ad09fce65e714157b560b8b2f572875260408601526060850152608084015260a083015260c082015260c08152610d4b60e082611073565b51902014158a8080610b72565b925060c083015182518d87519160018060a01b0388511691516040519260208401947f72ceb0851704fcf38d6586d280d22acb4e746f8f6ff0d7ee76d21ac40b99c8bc865260408501526060840152608083015260a082015260a08152610dc060c082611073565b519020141592610b6b565b63392334ed60e01b5f5260045ffd5b506101408201516101208301516001600160401b03918216911611610acd565b50610140820151610e13906001600160401b0316611ec3565b15610ac6565b6101208401516001600160401b039081169116101590508c610abe565b61012085015190519192506001600160401b0390811691811663240c840001908111610e6e576001600160401b03161415908d610ab6565b634e487b7160e01b5f52601160045260245ffd5b661fffffdbf37bff1092508e610aae565b6001600160401b03831681119350610aa7565b9050604084015114158d610a7e565b51602001516101008601516001600160401b0391821691161091508e610a76565b8051602001518b5160e001516001600160401b039182169116119250610a6f565b60800151604051637d6344f160e01b8152919350602082600481335afa9182156104d4575f92610f2c575b501415918f610a67565b9091506020813d602011610f58575b81610f4860209383611073565b810103126104c85751905f610f22565b3d9150610f3b565b60608101518c51610140015114159350610a60565b60408101518b14159350610a59565b50835115610a47565b5060a08501516001600160401b031615610a40565b50608085015115610a39565b508860208601511415610a32565b9181601f840112156104c8578235916001600160401b0383116104c857602083818601950101116104c857565b61012081019081106001600160401b038211176105ea57604052565b61010081019081106001600160401b038211176105ea57604052565b6101e081019081106001600160401b038211176105ea57604052565b60c081019081106001600160401b038211176105ea57604052565b606081019081106001600160401b038211176105ea57604052565b601f909101601f19168101906001600160401b038211908210176105ea57604052565b35906001600160401b03821682036104c857565b35906001600160a01b03821682036104c857565b359081151582036104c857565b809291039161042083126104c8576040516110e581611021565b80938235825260208301356020830152611101604084016110aa565b604083015261111260608401611096565b60608301526080830135608083015261112d60a08401611096565b60a083015260c083013560c083015261114860e08401611096565b60e083015260e060ff198201126104c85760405160e081016001600160401b038111828210176105ea57604052610100840135815261118a61012085016110aa565b6020820152610140840135604082015261016084013560608201526111b26101808501611096565b60808201526101a084013560a08201526101c084013560c08201526101008301526101e083013561012083015261020083013561014083015261022083013561016083015261024083013561018083015261010061025f198201126104c85760c09060405161122081611005565b61122d61026086016110be565b815261028085013560208201526112476102a08601611096565b60408201526112596102c08601611096565b60608201526102e0850135608082015261030085013560a08201526112816103208601611096565b838201526112926103408601611096565b60e08201526101a084015261035f1901126104c8576101c090611306610400604051946112be8661103d565b6112cb61036082016110be565b865261038081013560208701526103a081013560408701526103c081013560608701526112fb6103e08201611096565b608087015201611096565b60a08401520152565b909392938483116104c85784116104c8578101920390565b6001600160401b0381116105ea57601f01601f191660200190565b92919261134e82611327565b9161135c6040519384611073565b8294818452818301116104c8578281602093845f960137010152565b604051906113858261103d565b5f60a0838281528260208201528260408201528260608201528260808201520152565b5f604080516113b681611058565b828152826020820152015260018060a01b0316604051633fa8430d60e11b8152602081600481855afa9081156104d4575f9161140b575b50604051916113fb83611058565b4683526020830152604082015290565b90506020813d602011611435575b8161142660209383611073565b810103126104c857515f6113ed565b3d9150611419565b42158015611467575b610dcb57426001600160401b039081166103e802908116908103610e6e5790565b5065083126e978d44211611446565b51906001600160401b03821682036104c857565b92611493611378565b50825115908115611bd2575b8115611bb7575b508015611b46575b8015611ad5575b8015611a64575b80156119f3575b6105fe576020820192835192604081019061150c60018060a01b038351169560018060401b0360608401511696608084019788519160018060401b0360a0870151169388611c40565b815160c08201805160e084015160405163db89cf5b60e01b81529297936001600160a01b03888116946001600160401b0390931692911690602081600481885afa9081156104d4575f916119b1575b50604051635c2aedc160e11b815292602084600481895afa9384156104d4575f94611976575b509360c4916103e88596604096500485519687958694636e1a895560e11b8652600486015260248501527f08aaf5e7a98710f56656e185fdc1891b69e9445877f9f15cce76abafdda7ce3d60448501528860648501526084840152600180871b031660a483015260018060a01b03165afa9081156104d4575f9161192e575b50156104df57600491602061010085015192604051948580926367b2cf1d60e01b82525afa9283156104d4575f936118ea575b5081518151148015906118d0575b80156118be575b80156118b2575b801561189d575b8015611891575b8015611885575b6105fe5760405f91015160446060840151916040519586938492635134816760e11b84526004840152602483015260018060a01b03165afa9182156104d4575f92611795575b5060208201516002811015611781571591821592611761575b821561174c575b50506105fe576101c0816116e66101a06116f094015186611ee8565b0192835190612102565b51935192519051608081015160a09091015192516040519590946001600160401b03948516949092169291906001600160a01b031661172e8761103d565b8652602086015260408501526060840152608083015260a082015290565b60a09192506080015191015114155f806116ca565b604081015160808301516001600160401b039081169116141592506116c3565b634e487b7160e01b5f52602160045260245ffd5b9091503d805f833e6117a78183611073565b8101906020818303126104c8578051906001600160401b0382116104c857019060c0828203126104c857604051916117de8361103d565b80518352602081015160028110156104c857602084015261180160408201611476565b604084015261181260608201611476565b60608401526080818101519084015260a0810151906001600160401b0382116104c8570181601f820112156104c85780519061184d82611327565b9261185b6040519485611073565b828452602083830101116104c857815f9260208093018386015e8301015260a0820152905f6116aa565b5060c082015115611664565b5060a08201511561165d565b5060808201516001600160401b031615611656565b5060608201511561164f565b50604082015160408201511415611648565b5060208201516001600160a01b0384811691161415611641565b9092506020813d602011611926575b8161190660209383611073565b810103126104c857516001600160a01b03811681036104c857915f611633565b3d91506118f9565b90506040813d60401161196e575b8161194960409383611073565b810103126104c857602061195c82611c33565b91015160ff8116036104c8575f611600565b3d915061193c565b919350936020823d6020116119a9575b8161199360209383611073565b810103126104c8579051909390929060c4611581565b3d9150611986565b90506020813d6020116119eb575b816119cc60209383611073565b810103126104c857516001600160a01b03811681036104c8575f61155b565b3d91506119bf565b5061018082015160405163bf646d8560e01b8152906020826004816001600160a01b0389165afa9182156104d4575f92611a30575b5014156114c3565b9091506020813d602011611a5c575b81611a4c60209383611073565b810103126104c85751905f611a28565b3d9150611a3f565b50610160820151604051630804275960e31b8152906020826004816001600160a01b0389165afa9182156104d4575f92611aa1575b5014156114bc565b9091506020813d602011611acd575b81611abd60209383611073565b810103126104c85751905f611a99565b3d9150611ab0565b506101408201516040516309319cff60e01b8152906020826004816001600160a01b0389165afa9182156104d4575f92611b12575b5014156114b5565b9091506020813d602011611b3e575b81611b2e60209383611073565b810103126104c85751905f611b0a565b3d9150611b21565b50610120820151604051630d11264f60e11b8152906020826004816001600160a01b0389165afa9182156104d4575f92611b83575b5014156114ae565b9091506020813d602011611baf575b81611b9f60209383611073565b810103126104c85751905f611b7b565b3d9150611b92565b60e08401516001600160401b0390811691161090505f6114a6565b60e0840151909150611bec906001600160401b0316611ec3565b159061149f565b611c31906020808095946040519684889551918291018487015e8401908282015f8152815193849201905e01015f815203601f198101845283611073565b565b519081151582036104c857565b6040516381638e9b60e01b8152600481018390526001600160a01b03909116959394919290919060a0836024818a5afa9586156104d4575f905f915f935f965f9a611e44575b5060a060249a9b6040519b8c809263ef161bcb60e01b82528a60048301525afa9788156104d4575f9a5f99611de1575b50159a8b15611dcf575b8b15611dbd575b8b15611db4575b8b15611da2575b8b15611d99575b508a15611d81575b50508815611d69575b50508615611d5e575b50508415611d47575b508315611d3e575b508215611d26575b5050611d1757565b63178423dd60e01b5f5260045ffd5b6001600160401b039182169116141590505f80611d0f565b1592505f611d07565b6001600160401b038381169116141593505f611cff565b141594505f80611cf6565b6001600160401b039182169116141596505f80611ced565b6001600160a01b039182169116141598505f80611ce4565b159a505f611cdc565b6001600160401b038a16159b50611cd5565b86159b50611cce565b6001600160401b038416159b50611cc7565b6001600160a01b038216159b50611cc0565b9a50975060a08a3d60a011611e3c575b81611dfe60a09383611073565b810103126104c857611e356080611e148c611476565b9b611e2160208201611476565b50611e2e60408201611476565b5001611c33565b975f611cb6565b3d9150611df1565b945095505096505060a0813d60a011611ebb575b81611e6560a09383611073565b810103126104c8578051926001600160a01b03841684036104c857602496611e8f60208401611476565b60408401519260a0611eaf6080611ea860608901611476565b9701611c33565b97929495979a50611c86565b3d9150611e58565b6001600160401b03168015159081611ed9575090565b661fffffffffffff9150111590565b60018060401b0360e0830151166204650081109081156120f5575b81156120c9575b50611f865781511561205357602082019160808351602460405180958193634bd8588b60e01b8352600483015260018060a01b03165afa9283156104d4575f5f915f945f96611ff2575b505115948515611fe5575b8515611fdc575b508415611fc0575b508315611fa4575b508215611f95575b5050611f8657565b632fa0ffc960e11b5f5260045ffd5b60800151141590505f80611f7e565b60408201516001600160401b039182169116141592505f611f76565b60608301516001600160401b039182169116141593505f611f6e565b1594505f611f66565b60a0840151159550611f5f565b9450945050506080823d60801161204b575b8161201160809383611073565b810103126104c85761202282611476565b9161202f60208201611476565b612040606060408401519301611c33565b93909193945f611f54565b3d9150612004565b50602081015115908115916120b2575b811561209b575b811561208d575b811561207f575b50611f8657565b60a09150015115155f612078565b608081015115159150612071565b60608101516001600160401b03161515915061206a565b60408101516001600160401b031615159150612063565b60c08401516001600160401b039081169250908103908111610e6e576001600160401b0316105f611f0a565b6215f90081119150611f03565b9080511561222457602081015115918215612217575b82156121a0575b50811561217f575b811561215e575b811561213c575b506105fe57565b608081015160a0909101516001600160401b039182169116111590505f612135565b60a0810151909150612178906001600160401b0316611ec3565b159061212e565b6080810151909150612199906001600160401b0316611ec3565b1590612127565b606082015160405163a363a26760e01b815292935090602090839060049082906001600160a01b03165afa9182156104d4575f926121e3575b501415905f61211f565b9091506020813d60201161220f575b816121ff60209383611073565b810103126104c85751905f6121d9565b3d91506121f2565b6040820151159250612118565b6020810151158015925061228a575b811561227c575b8115612265575b811561224e57506105fe57565b60a001516001600160401b0316151590505f612135565b60808101516001600160401b031615159150612241565b60608101511515915061223a565b60408101511515915061223356fea26469706673582212207d48e0a3861303e93b5e2190aa55794741f753dfe7d5b1643037a219bb887d6564736f6c634300081e0033" as const;
