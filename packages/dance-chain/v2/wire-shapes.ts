// Generated from actual solc ABI/AST by harness/megaeth/generate-publication-consent.ts.
export const danceOperation = {
  "configureOwner": 1,
  "grantReviewer": 2,
  "revokeReviewer": 3,
  "bindIdentity": 4,
  "mergeGroups": 5,
  "setReference": 6,
  "registerSubmission": 7,
  "commitVerdict": 8,
  "invalidateSubmission": 9,
  "invalidateRules": 10
} as const;
export const dancePayloads = {
  "configureOwner": {
    "name": "payload",
    "type": "tuple",
    "components": [
      {
        "name": "expectedOwnerEpoch",
        "type": "uint64"
      },
      {
        "name": "expectedConfigurationRevision",
        "type": "uint64"
      },
      {
        "name": "expectedController",
        "type": "address"
      },
      {
        "name": "expectedPublisher",
        "type": "address"
      },
      {
        "name": "expectedConsentRegistry",
        "type": "address"
      },
      {
        "name": "ownerWallet",
        "type": "address"
      },
      {
        "name": "validFromSeconds",
        "type": "uint64"
      },
      {
        "name": "expiresAtSeconds",
        "type": "uint64"
      },
      {
        "name": "policyHash",
        "type": "bytes32"
      }
    ]
  },
  "grantReviewer": {
    "name": "payload",
    "type": "tuple",
    "components": [
      {
        "name": "expectedOwnerEpoch",
        "type": "uint64"
      },
      {
        "name": "expectedConfigurationRevision",
        "type": "uint64"
      },
      {
        "name": "reviewerWallet",
        "type": "address"
      },
      {
        "name": "expectedReviewerEpoch",
        "type": "uint64"
      },
      {
        "name": "expiresAtSeconds",
        "type": "uint64"
      }
    ]
  },
  "revokeReviewer": {
    "name": "payload",
    "type": "tuple",
    "components": [
      {
        "name": "expectedOwnerEpoch",
        "type": "uint64"
      },
      {
        "name": "expectedConfigurationRevision",
        "type": "uint64"
      },
      {
        "name": "reviewerWallet",
        "type": "address"
      },
      {
        "name": "expectedReviewerEpoch",
        "type": "uint64"
      }
    ]
  },
  "bindIdentity": {
    "name": "payload",
    "type": "tuple",
    "components": [
      {
        "name": "expectedOwnerEpoch",
        "type": "uint64"
      },
      {
        "name": "expectedConfigurationRevision",
        "type": "uint64"
      },
      {
        "name": "accountCommitment",
        "type": "bytes32"
      },
      {
        "name": "wallet",
        "type": "address"
      },
      {
        "name": "expectedIdentityEpoch",
        "type": "uint64"
      },
      {
        "name": "sourceGroupId",
        "type": "bytes32"
      },
      {
        "name": "sourceBindingGroupEpoch",
        "type": "uint64"
      },
      {
        "name": "sourceCurrentGroupEpoch",
        "type": "uint64"
      },
      {
        "name": "destinationGroupId",
        "type": "bytes32"
      },
      {
        "name": "destinationGroupEpoch",
        "type": "uint64"
      },
      {
        "name": "createSingleton",
        "type": "bool"
      },
      {
        "name": "active",
        "type": "bool"
      }
    ]
  },
  "mergeGroups": {
    "name": "payload",
    "type": "tuple",
    "components": [
      {
        "name": "expectedOwnerEpoch",
        "type": "uint64"
      },
      {
        "name": "expectedConfigurationRevision",
        "type": "uint64"
      },
      {
        "name": "leftGroupId",
        "type": "bytes32"
      },
      {
        "name": "expectedLeftEpoch",
        "type": "uint64"
      },
      {
        "name": "rightGroupId",
        "type": "bytes32"
      },
      {
        "name": "expectedRightEpoch",
        "type": "uint64"
      },
      {
        "name": "newGroupId",
        "type": "bytes32"
      }
    ]
  },
  "setReference": {
    "name": "payload",
    "type": "tuple",
    "components": [
      {
        "name": "expectedOwnerEpoch",
        "type": "uint64"
      },
      {
        "name": "expectedConfigurationRevision",
        "type": "uint64"
      },
      {
        "name": "referenceId",
        "type": "bytes32"
      },
      {
        "name": "expectedReferenceEpoch",
        "type": "uint64"
      },
      {
        "name": "revision",
        "type": "uint64"
      },
      {
        "name": "segmentLayoutSha256",
        "type": "bytes32"
      },
      {
        "name": "active",
        "type": "bool"
      }
    ]
  },
  "registerSubmission": {
    "name": "payload",
    "type": "tuple",
    "components": [
      {
        "name": "expectedOwnerEpoch",
        "type": "uint64"
      },
      {
        "name": "expectedConfigurationRevision",
        "type": "uint64"
      },
      {
        "name": "expectedRulesEpoch",
        "type": "uint64"
      },
      {
        "name": "expectedMediaEpoch",
        "type": "uint64"
      },
      {
        "name": "capture",
        "type": "tuple",
        "components": [
          {
            "name": "captureId",
            "type": "bytes32"
          },
          {
            "name": "accountCommitment",
            "type": "bytes32"
          },
          {
            "name": "learner",
            "type": "address"
          },
          {
            "name": "identityEpoch",
            "type": "uint64"
          },
          {
            "name": "groupId",
            "type": "bytes32"
          },
          {
            "name": "groupEpoch",
            "type": "uint64"
          },
          {
            "name": "publicationGrantId",
            "type": "bytes32"
          },
          {
            "name": "reservedAtMs",
            "type": "uint64"
          },
          {
            "name": "song",
            "type": "tuple",
            "components": [
              {
                "name": "chainId",
                "type": "uint256"
              },
              {
                "name": "posts",
                "type": "address"
              },
              {
                "name": "communityId",
                "type": "bytes32"
              },
              {
                "name": "postId",
                "type": "bytes32"
              },
              {
                "name": "revision",
                "type": "uint64"
              },
              {
                "name": "manifestSha256",
                "type": "bytes32"
              },
              {
                "name": "audioSha256",
                "type": "bytes32"
              }
            ]
          },
          {
            "name": "rulesSha256",
            "type": "bytes32"
          },
          {
            "name": "termsSha256",
            "type": "bytes32"
          },
          {
            "name": "rubricSha256",
            "type": "bytes32"
          },
          {
            "name": "mediaPolicySha256",
            "type": "bytes32"
          },
          {
            "name": "referenceSelection",
            "type": "tuple",
            "components": [
              {
                "name": "present",
                "type": "bool"
              },
              {
                "name": "id",
                "type": "bytes32"
              },
              {
                "name": "revision",
                "type": "uint64"
              },
              {
                "name": "epoch",
                "type": "uint64"
              },
              {
                "name": "segmentLayoutSha256",
                "type": "bytes32"
              },
              {
                "name": "segmentId",
                "type": "bytes32"
              },
              {
                "name": "startSample",
                "type": "uint64"
              },
              {
                "name": "durationSamples",
                "type": "uint64"
              }
            ]
          },
          {
            "name": "offer",
            "type": "tuple",
            "components": [
              {
                "name": "present",
                "type": "bool"
              },
              {
                "name": "offerIdCommitment",
                "type": "bytes32"
              },
              {
                "name": "inputHash",
                "type": "bytes32"
              },
              {
                "name": "sourceHash",
                "type": "bytes32"
              },
              {
                "name": "opensAtMs",
                "type": "uint64"
              },
              {
                "name": "cutoffAtMs",
                "type": "uint64"
              }
            ]
          }
        ]
      },
      {
        "name": "consent",
        "type": "tuple",
        "components": [
          {
            "name": "accepted",
            "type": "bool"
          },
          {
            "name": "acceptedAtMs",
            "type": "uint64"
          },
          {
            "name": "captureHash",
            "type": "bytes32"
          },
          {
            "name": "termsSha256",
            "type": "bytes32"
          },
          {
            "name": "publicityPolicyHash",
            "type": "bytes32"
          }
        ]
      },
      {
        "name": "submission",
        "type": "tuple",
        "components": [
          {
            "name": "submissionId",
            "type": "bytes32"
          },
          {
            "name": "captureHash",
            "type": "bytes32"
          },
          {
            "name": "consentHash",
            "type": "bytes32"
          },
          {
            "name": "mediaBindingHash",
            "type": "bytes32"
          },
          {
            "name": "mediaIdCommitment",
            "type": "bytes32"
          },
          {
            "name": "mediaGeneration",
            "type": "uint64"
          },
          {
            "name": "recordingReplayKey",
            "type": "bytes32"
          },
          {
            "name": "recordingBindingHash",
            "type": "bytes32"
          },
          {
            "name": "trustedSubmittedAtMs",
            "type": "uint64"
          },
          {
            "name": "reviewDeadlineMs",
            "type": "uint64"
          },
          {
            "name": "mediaExpiresAtMs",
            "type": "uint64"
          }
        ]
      },
      {
        "name": "recordingSha256",
        "type": "bytes32"
      }
    ]
  },
  "commitVerdict": {
    "name": "payload",
    "type": "tuple",
    "components": [
      {
        "name": "decision",
        "type": "tuple",
        "components": [
          {
            "name": "submissionId",
            "type": "bytes32"
          },
          {
            "name": "verdict",
            "type": "uint8"
          },
          {
            "name": "reviewerAccountCommitment",
            "type": "bytes32"
          },
          {
            "name": "reviewerWallet",
            "type": "address"
          },
          {
            "name": "reviewerPublicationGrantId",
            "type": "bytes32"
          },
          {
            "name": "reviewerIdentityEpoch",
            "type": "uint64"
          },
          {
            "name": "reviewerGroupId",
            "type": "bytes32"
          },
          {
            "name": "reviewerGroupEpoch",
            "type": "uint64"
          },
          {
            "name": "expectedOwnerEpoch",
            "type": "uint64"
          },
          {
            "name": "expectedReviewerRoleEpoch",
            "type": "uint64"
          },
          {
            "name": "expectedMediaEpoch",
            "type": "uint64"
          },
          {
            "name": "intentAcceptedAtMs",
            "type": "uint64"
          },
          {
            "name": "expectedConfigurationRevision",
            "type": "uint64"
          },
          {
            "name": "expectedRulesEpoch",
            "type": "uint64"
          },
          {
            "name": "reviewerConsentHash",
            "type": "bytes32"
          }
        ]
      }
    ]
  },
  "invalidateSubmission": {
    "name": "payload",
    "type": "tuple",
    "components": [
      {
        "name": "captureId",
        "type": "bytes32"
      },
      {
        "name": "learnerWallet",
        "type": "address"
      },
      {
        "name": "expectedMediaEpoch",
        "type": "uint64"
      },
      {
        "name": "reason",
        "type": "uint8"
      }
    ]
  },
  "invalidateRules": {
    "name": "payload",
    "type": "tuple",
    "components": [
      {
        "name": "expectedRulesEpoch",
        "type": "uint64"
      },
      {
        "name": "expectedOwnerEpoch",
        "type": "uint64"
      },
      {
        "name": "expectedConfigurationRevision",
        "type": "uint64"
      }
    ]
  }
} as const;
export const danceShapes = {
  "capture": {
    "name": "capture",
    "type": "tuple",
    "components": [
      {
        "name": "captureId",
        "type": "bytes32"
      },
      {
        "name": "accountCommitment",
        "type": "bytes32"
      },
      {
        "name": "learner",
        "type": "address"
      },
      {
        "name": "identityEpoch",
        "type": "uint64"
      },
      {
        "name": "groupId",
        "type": "bytes32"
      },
      {
        "name": "groupEpoch",
        "type": "uint64"
      },
      {
        "name": "publicationGrantId",
        "type": "bytes32"
      },
      {
        "name": "reservedAtMs",
        "type": "uint64"
      },
      {
        "name": "song",
        "type": "tuple",
        "components": [
          {
            "name": "chainId",
            "type": "uint256"
          },
          {
            "name": "posts",
            "type": "address"
          },
          {
            "name": "communityId",
            "type": "bytes32"
          },
          {
            "name": "postId",
            "type": "bytes32"
          },
          {
            "name": "revision",
            "type": "uint64"
          },
          {
            "name": "manifestSha256",
            "type": "bytes32"
          },
          {
            "name": "audioSha256",
            "type": "bytes32"
          }
        ]
      },
      {
        "name": "rulesSha256",
        "type": "bytes32"
      },
      {
        "name": "termsSha256",
        "type": "bytes32"
      },
      {
        "name": "rubricSha256",
        "type": "bytes32"
      },
      {
        "name": "mediaPolicySha256",
        "type": "bytes32"
      },
      {
        "name": "referenceSelection",
        "type": "tuple",
        "components": [
          {
            "name": "present",
            "type": "bool"
          },
          {
            "name": "id",
            "type": "bytes32"
          },
          {
            "name": "revision",
            "type": "uint64"
          },
          {
            "name": "epoch",
            "type": "uint64"
          },
          {
            "name": "segmentLayoutSha256",
            "type": "bytes32"
          },
          {
            "name": "segmentId",
            "type": "bytes32"
          },
          {
            "name": "startSample",
            "type": "uint64"
          },
          {
            "name": "durationSamples",
            "type": "uint64"
          }
        ]
      },
      {
        "name": "offer",
        "type": "tuple",
        "components": [
          {
            "name": "present",
            "type": "bool"
          },
          {
            "name": "offerIdCommitment",
            "type": "bytes32"
          },
          {
            "name": "inputHash",
            "type": "bytes32"
          },
          {
            "name": "sourceHash",
            "type": "bytes32"
          },
          {
            "name": "opensAtMs",
            "type": "uint64"
          },
          {
            "name": "cutoffAtMs",
            "type": "uint64"
          }
        ]
      }
    ]
  },
  "consent": {
    "name": "consent",
    "type": "tuple",
    "components": [
      {
        "name": "accepted",
        "type": "bool"
      },
      {
        "name": "acceptedAtMs",
        "type": "uint64"
      },
      {
        "name": "captureHash",
        "type": "bytes32"
      },
      {
        "name": "termsSha256",
        "type": "bytes32"
      },
      {
        "name": "publicityPolicyHash",
        "type": "bytes32"
      }
    ]
  },
  "submission": {
    "name": "submission",
    "type": "tuple",
    "components": [
      {
        "name": "submissionId",
        "type": "bytes32"
      },
      {
        "name": "captureHash",
        "type": "bytes32"
      },
      {
        "name": "consentHash",
        "type": "bytes32"
      },
      {
        "name": "mediaBindingHash",
        "type": "bytes32"
      },
      {
        "name": "mediaIdCommitment",
        "type": "bytes32"
      },
      {
        "name": "mediaGeneration",
        "type": "uint64"
      },
      {
        "name": "recordingReplayKey",
        "type": "bytes32"
      },
      {
        "name": "recordingBindingHash",
        "type": "bytes32"
      },
      {
        "name": "trustedSubmittedAtMs",
        "type": "uint64"
      },
      {
        "name": "reviewDeadlineMs",
        "type": "uint64"
      },
      {
        "name": "mediaExpiresAtMs",
        "type": "uint64"
      }
    ]
  },
  "decision": {
    "name": "decision",
    "type": "tuple",
    "components": [
      {
        "name": "submissionId",
        "type": "bytes32"
      },
      {
        "name": "verdict",
        "type": "uint8"
      },
      {
        "name": "reviewerAccountCommitment",
        "type": "bytes32"
      },
      {
        "name": "reviewerWallet",
        "type": "address"
      },
      {
        "name": "reviewerPublicationGrantId",
        "type": "bytes32"
      },
      {
        "name": "reviewerIdentityEpoch",
        "type": "uint64"
      },
      {
        "name": "reviewerGroupId",
        "type": "bytes32"
      },
      {
        "name": "reviewerGroupEpoch",
        "type": "uint64"
      },
      {
        "name": "expectedOwnerEpoch",
        "type": "uint64"
      },
      {
        "name": "expectedReviewerRoleEpoch",
        "type": "uint64"
      },
      {
        "name": "expectedMediaEpoch",
        "type": "uint64"
      },
      {
        "name": "intentAcceptedAtMs",
        "type": "uint64"
      },
      {
        "name": "expectedConfigurationRevision",
        "type": "uint64"
      },
      {
        "name": "expectedRulesEpoch",
        "type": "uint64"
      },
      {
        "name": "reviewerConsentHash",
        "type": "bytes32"
      }
    ]
  },
  "policy": {
    "name": "policy",
    "type": "tuple",
    "components": [
      {
        "name": "rulesSha256",
        "type": "bytes32"
      },
      {
        "name": "termsSha256",
        "type": "bytes32"
      },
      {
        "name": "rubricSha256",
        "type": "bytes32"
      },
      {
        "name": "mediaPolicySha256",
        "type": "bytes32"
      },
      {
        "name": "consentDisclosureSha256",
        "type": "bytes32"
      },
      {
        "name": "privacySha256",
        "type": "bytes32"
      }
    ]
  },
  "sourcePin": {
    "name": "sourcePin",
    "type": "tuple",
    "components": [
      {
        "name": "directory",
        "type": "address"
      },
      {
        "name": "directoryRuntimeHash",
        "type": "bytes32"
      },
      {
        "name": "consentRegistry",
        "type": "address"
      },
      {
        "name": "consentRegistryRuntimeHash",
        "type": "bytes32"
      },
      {
        "name": "posts",
        "type": "address"
      },
      {
        "name": "postsRuntimeHash",
        "type": "bytes32"
      },
      {
        "name": "executionRule",
        "type": "bytes32"
      },
      {
        "name": "learnerConsentPolicyHash",
        "type": "bytes32"
      },
      {
        "name": "reviewerConsentPolicyHash",
        "type": "bytes32"
      },
      {
        "name": "publicityPolicyHash",
        "type": "bytes32"
      },
      {
        "name": "rulesSha256",
        "type": "bytes32"
      },
      {
        "name": "termsSha256",
        "type": "bytes32"
      },
      {
        "name": "rubricSha256",
        "type": "bytes32"
      },
      {
        "name": "mediaPolicySha256",
        "type": "bytes32"
      },
      {
        "name": "deploymentBlock",
        "type": "uint64"
      },
      {
        "name": "runtimeCodeHash",
        "type": "bytes32"
      }
    ]
  }
} as const;
