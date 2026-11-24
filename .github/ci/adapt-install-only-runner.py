"""Adapt the sealed r17 install-only host runner to a GitHub Blacksmith runner."""
import hashlib
import os
from pathlib import Path
import shlex
import sys


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def replace(raw, old, new):
    assert raw.count(old) == 1, (old, raw.count(old))
    return raw.replace(old, new)


def main():
    assets = Path(sys.argv[1]).resolve(strict=True)
    bundle = Path(sys.argv[2]).resolve(strict=True)
    scratch = Path(os.environ['RUNNER_TEMP']) / 'pirate-vm-scratch'
    scratch.mkdir(mode=0o700, parents=True, exist_ok=True)
    runner = bundle / 'run-install-only.sh'
    raw = runner.read_text()
    raw = replace(raw, 'scratch=/media/t42/codedrive/tmp', 'scratch=' + shlex.quote(str(scratch)))
    raw = replace(raw, 'image_dir=$scratch/pirate-offline-native-vm.8kSyg3', 'image_dir=' + shlex.quote(str(assets)))
    raw = replace(raw, 'public=$scratch/pirate-offline-noble-docker-29.9.3.J8316N5g/docker-prereqs.iso',
                  'public=' + shlex.quote(str(assets / 'docker-prereqs.iso')))
    raw = replace(raw, 'browser=/media/t42/codedrive/tmp/pirate-machine-smoke-transfer-fix.hDhlNA2M/browser-display.iso',
                  'browser=' + shlex.quote(str(assets / 'browser-display.iso')))
    raw = replace(raw, 'review=/var/tmp/pirate-l6-readiness-authorizer.kZXwkcQ3/NATIVE-MACHINE-GROUP-AND-ISOLATION.md',
                  'review=' + shlex.quote(str(assets / 'review.md')))
    raw = replace(raw, 'smoke=/media/t42/codedrive/tmp/pirate-visit2-native-runtime-hotfix-notes-media.20261124-r24/materialization/smoke-inputs.iso',
                  'smoke=' + shlex.quote(str(assets / 'smoke-inputs.iso')))
    raw = replace(raw, 'entry=/media/t42/codedrive/tmp/pirate-visit2-native-runtime-hotfix-notes-media.20261124-r24/selected/notes-entry.iso',
                  'entry=' + shlex.quote(str(assets / 'notes-entry.iso')))
    raw = replace(raw, 'derivative=/media/t42/codedrive/tmp/pirate-visit2-native-runtime-ca-bundle-hotfix-derivative-inputs.20261123-r17/derivative-inputs.iso',
                  'derivative=' + shlex.quote(str(assets / 'derivative-inputs.iso')))
    raw = replace(raw, 'diagnostic=/media/t42/codedrive/tmp/pirate-visit2-install-only-rerun.20261124-r17/install-diagnostic.iso',
                  'diagnostic=' + shlex.quote(str(bundle / 'install-diagnostic.iso')))
    raw = replace(raw, '[[ "$(hostname)" == t42 && -r /dev/kvm && -w /dev/kvm ]]',
                  '[[ -r /dev/kvm && -w /dev/kvm ]]')
    runner.write_text(raw)
    runner.chmod(0o700)
    inputs = [assets / 'ubuntu-base.qcow2', assets / 'base-vmlinuz', assets / 'base-initrd',
              assets / 'docker-prereqs.iso', assets / 'browser-display.iso', assets / 'review.md',
              assets / 'smoke-inputs.iso', assets / 'notes-entry.iso', assets / 'derivative-inputs.iso',
              bundle / 'install-diagnostic.iso', bundle / 'guest-notes-bootstrap.sh',
              bundle / 'collect-notes-evidence.py', bundle / 'docker-info-probe.py',
              bundle / 'prepare-install-only.sh', bundle / 'guest-notes-controller.py',
              bundle / 'verify-install-only.py']
    (bundle / 'INPUT-SHA256SUMS').write_text(''.join(f'{digest(path)}  {path}\n' for path in inputs))
    (bundle / 'INPUT-SHA256SUMS').chmod(0o400)
    print('CI runner adapted')


if __name__ == '__main__':
    main()
