type StudyAsrStage =
  | "host_pin"
  | "host_lease"
  | "host_body"
  | "host_upload_deadline"
  | "host_processing_deadline"
  | "host_response_delivery"
  | "host_peer_interrupted"
  | "host_child_start"
  | "host_child_stdin"
  | "host_child_output_limit"
  | "host_child_forced_stop"
  | "host_child_exit"
  | "worker_transport_deadline"
  | "worker_transport_failed"
  | "worker_host_busy"
  | "worker_host_deadline"
  | "worker_host_auth_rejected"
  | "worker_host_body_rejected"
  | "worker_host_rejected"
  | "worker_body_missing"
  | "worker_body_read"
  | "worker_body_limit"
  | "worker_body_decode";

/** Fixed process-local diagnostics. Never supply exceptions, request fields,
 * signed parameters, identifiers, output or a provider response as log values. */
export function noteStudyAsrStage(stage: StudyAsrStage): void {
  try { console.warn("pirate_native_study_asr:" + stage); }
  catch { /* Diagnostic sinks cannot change dispatch or its outcome. */ }
}
