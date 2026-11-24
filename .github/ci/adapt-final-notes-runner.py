"""Adapt the sealed final Notes host runner to a GitHub Blacksmith runner."""
import hashlib
import os
from pathlib import Path
import shlex
import sys


def replace(raw, old, new):
    assert raw.count(old) == 1, (old, raw.count(old))
    return raw.replace(old, new)


def main():
    assets = Path(sys.argv[1]).resolve(strict=True)
    bundle = Path(sys.argv[2]).resolve(strict=True)
    scratch = Path(os.environ['RUNNER_TEMP']) / 'pirate-final-vm-scratch'
    scratch.mkdir(mode=0o700, parents=True, exist_ok=True)
    runner = bundle / 'run-notes.sh'
    raw = runner.read_text()
    raw = replace(raw, 'scratch=/media/t42/codedrive/tmp', 'scratch=' + shlex.quote(str(scratch)))
    raw = replace(raw, 'image_dir=$scratch/pirate-offline-native-vm.8kSyg3', 'image_dir=' + shlex.quote(str(assets)))
    raw = replace(raw, 'base=$image_dir/ubuntu-24.04-server-cloudimg-amd64.img', 'base=$image_dir/ubuntu-base.qcow2')
    raw = replace(raw, 'public=$scratch/pirate-offline-noble-docker-29.9.3.J8316N5g/docker-prereqs.iso',
                  'public=' + shlex.quote(str(assets / 'docker-prereqs.iso')))
    raw = replace(raw, 'browser=/media/t42/codedrive/tmp/pirate-machine-smoke-transfer-fix.hDhlNA2M/browser-display.iso',
                  'browser=' + shlex.quote(str(assets / 'browser-display.iso')))
    raw = replace(raw, 'review=/var/tmp/pirate-l6-readiness-authorizer.kZXwkcQ3/NATIVE-MACHINE-GROUP-AND-ISOLATION.md',
                  'review=' + shlex.quote(str(assets / 'review.md')))
    raw = replace(raw, '[[ "$(hostname)" == t42 && -r /dev/kvm && -w /dev/kvm ]]',
                  '[[ -r /dev/kvm && -w /dev/kvm ]]')
    raw = replace(raw, '  cat /proc/pressure/memory\n',
                  '  if [[ -r /proc/pressure/memory ]]; then cat /proc/pressure/memory; fi\n')
    runner.write_text(raw)
    runner.chmod(0o700)
    manifest = bundle / 'NOTES-EXECUTION-SHA256SUMS'
    lines = []
    replaced = 0
    runner_pin = hashlib.sha256(runner.read_bytes()).hexdigest()
    for line in manifest.read_text().splitlines():
        pin, separator, name = line.partition('  ')
        assert separator
        if name == 'run-notes.sh':
            line = f'{runner_pin}  {name}'
            replaced += 1
        lines.append(line)
    assert replaced == 1
    manifest.write_text('\n'.join(lines) + '\n')
    manifest.chmod(0o600)
    print('Final CI runner adapted')


if __name__ == '__main__':
    main()
