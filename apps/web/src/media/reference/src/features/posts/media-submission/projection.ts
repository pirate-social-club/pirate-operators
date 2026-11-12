export type SongSubmissionView =
  | { readonly status: "editing" }
  | { readonly status: "reconciling"; readonly submissionId?: string }
  | {
      readonly status: "uploading";
      readonly submissionId: string;
      readonly bytesSent: number;
      readonly bytesTotal: number;
    }
  | {
      readonly status: "processing";
      readonly submissionId: string;
      readonly phase:
        | "reserve"
        | "awaiting_upload"
        | "finalize"
        | "analysis"
        | "decision"
        | "publish";
    }
  | {
      readonly status: "action_required";
      readonly submissionId: string;
      readonly expiresAt: string;
      readonly referenceRequestRef: string;
    }
  | {
      readonly status: "manual_review";
      readonly submissionId: string;
      readonly reasonCode: "review_required" | "moderation_unavailable";
      readonly reviewRef: string;
    }
  | {
      readonly status: "published";
      readonly submissionId: string;
      readonly postHref: string;
      readonly postId: string;
    }
  | {
      readonly status: "blocked";
      readonly submissionId: string;
      readonly reasonCode: "policy_violation";
    }
  | {
      readonly status: "processing_failed";
      readonly submissionId: string;
      readonly reasonCode: string;
      readonly retryable: boolean;
    }
  | {
      readonly status: "abandoned";
      readonly submissionId: string;
      readonly reasonCode: string;
    };

export type MediaSubmissionSnapshot = SongSubmissionView;
export const projectMediaSubmission = (
  receipt: MediaSubmissionSnapshot,
): SongSubmissionView => receipt;
