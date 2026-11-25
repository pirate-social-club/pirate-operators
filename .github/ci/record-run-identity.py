#!/usr/bin/env python3
"""Record the exact Git, fixture, and product identities for one VM workflow run."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys


HEX40 = re.compile(r"[0-9a-f]{40}")
HEX64 = re.compile(r"[0-9a-f]{64}")


def git(repo, *args, required=True):
    result = subprocess.run(["git", "-C", str(repo), *args], text=True, capture_output=True)
    if result.returncode:
        if required:
            raise ValueError(f"git {' '.join(args)} failed: {result.stderr.strip()}")
        return None
    return result.stdout.strip()


def object_id(repo, revision, required=True):
    value = git(repo, "rev-parse", "--verify", revision, required=required)
    return value if value and HEX40.fullmatch(value) else None


def load_pin(path):
    pin = json.loads(path.read_bytes())
    release = pin.get("release")
    unchanged_release = pin.get("unchangedAssetRelease")
    manifest = pin.get("manifestSha256")
    head = pin.get("productSourceHead")
    tree = pin.get("productSourceTree")
    image = pin.get("fixtureImageId")
    if not isinstance(release, str) or not release:
        raise ValueError("fixture pin is missing release")
    if not isinstance(unchanged_release, str) or not unchanged_release:
        raise ValueError("fixture pin is missing unchangedAssetRelease")
    if unchanged_release == release:
        raise ValueError("fixture pin must use a distinct unchangedAssetRelease")
    if not isinstance(manifest, str) or not HEX64.fullmatch(manifest):
        raise ValueError("fixture pin has an invalid manifestSha256")
    if not isinstance(head, str) or not HEX40.fullmatch(head):
        raise ValueError("fixture pin has an invalid productSourceHead")
    if not isinstance(tree, str) or not HEX40.fullmatch(tree):
        raise ValueError("fixture pin has an invalid productSourceTree")
    if not isinstance(image, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", image):
        raise ValueError("fixture pin has an invalid fixtureImageId")
    return pin


def build_identity(repo, pin_path, env):
    pin = load_pin(pin_path)
    event = json.loads(Path(env["GITHUB_EVENT_PATH"]).read_bytes())
    event_name = env["GITHUB_EVENT_NAME"]
    github_sha = env["GITHUB_SHA"]
    if not HEX40.fullmatch(github_sha):
        raise ValueError("GITHUB_SHA is not a full Git object ID")
    head = github_sha
    base = None
    merge = None
    if event_name == "pull_request":
        pull = event.get("pull_request")
        if not isinstance(pull, dict):
            raise ValueError("pull_request event is missing pull_request")
        head = pull.get("head", {}).get("sha")
        base = pull.get("base", {}).get("sha")
        merge = pull.get("merge_commit_sha") or (github_sha if github_sha != head else None)
        if not isinstance(head, str) or not HEX40.fullmatch(head):
            raise ValueError("pull request head SHA is invalid")
        if not isinstance(base, str) or not HEX40.fullmatch(base):
            raise ValueError("pull request base SHA is invalid")
        if merge is not None and (not isinstance(merge, str) or not HEX40.fullmatch(merge)):
            raise ValueError("pull request merge SHA is invalid")
    checkout = git(repo, "rev-parse", "HEAD")
    if checkout != github_sha:
        raise ValueError(f"checkout HEAD {checkout} does not match GITHUB_SHA {github_sha}")
    return {
        "schema": "pirate.vm-run-identity/1",
        "recordedUtc": datetime.now(timezone.utc).isoformat(),
        "repository": env["GITHUB_REPOSITORY"],
        "runId": env["GITHUB_RUN_ID"],
        "runAttempt": env.get("GITHUB_RUN_ATTEMPT", "1"),
        "workflow": env["GITHUB_WORKFLOW"],
        "event": event_name,
        "headSha": head,
        "executedMergeSha": merge,
        "baseSha": base,
        "checkoutSha": checkout,
        "checkoutCiTreeSha": object_id(repo, f"{checkout}:.github/ci"),
        "checkoutFinalWorkflowBlobSha": object_id(
            repo, f"{checkout}:.github/workflows/pirate-vm-final-acceptance.yml"),
        "checkoutInstallWorkflowBlobSha": object_id(
            repo, f"{checkout}:.github/workflows/pirate-vm-install-only.yml"),
        "headCiTreeSha": object_id(repo, f"{head}:.github/ci", required=False),
        "headFinalWorkflowBlobSha": object_id(
            repo, f"{head}:.github/workflows/pirate-vm-final-acceptance.yml", required=False),
        "headInstallWorkflowBlobSha": object_id(
            repo, f"{head}:.github/workflows/pirate-vm-install-only.yml", required=False),
        "fixtureRelease": pin["release"],
        "unchangedAssetRelease": pin["unchangedAssetRelease"],
        "fixtureManifestSha256": pin["manifestSha256"],
        "fixturePinSha256": hashlib.sha256(pin_path.read_bytes()).hexdigest(),
        "productSourceHead": pin["productSourceHead"],
        "productSourceTree": pin["productSourceTree"],
        "fixtureImageId": pin["fixtureImageId"],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=Path.cwd())
    parser.add_argument("--pin", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        identity = build_identity(args.repo.resolve(strict=True), args.pin.resolve(strict=True), os.environ)
        args.output.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        args.output.write_text(json.dumps(identity, indent=2, sort_keys=True) + "\n")
        args.output.chmod(0o600)
    except (KeyError, OSError, ValueError, json.JSONDecodeError) as error:
        print(f"run identity failed: {error}", file=sys.stderr)
        return 1
    print(json.dumps(identity, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
