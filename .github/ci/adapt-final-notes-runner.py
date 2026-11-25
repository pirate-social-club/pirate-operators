"""Adapt the sealed final Notes host runner to a GitHub Blacksmith runner."""
import hashlib
import io
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tarfile


# Git-vendored harness source overlaid onto the sealed bundle. The sealed
# member hashes pin the exact r19 base each vendored file diverges from; bump
# them only in the commit that moves the fixture pin to a newer release.
VENDORED_SEALED_R19 = {
    'collect-notes-evidence.py': '332958b8e3877d5fe9671125a1e24958ecb8ea7662b3b720d8e0197699829913',
    'verify-notes-run.py': '8a0e4b947f017a51d99dd7bced97de736829b26478551c3f70a90b74c45f483b',
}

# Sealed close-instrumentation ISO members the guest actually executes, as
# pinned digests of the r19 packaging. The adapter verifies the packaged
# members against these digests before rebuilding the ISO around the vendored
# copies, so the vendored provenance claim is checked on every adaptation.
CLOSE_ISO_SEALED_R19 = {
    'controller/guest-notes-controller.py': '0c7d9883e32da572356454f15a39386aac9414d550725b06f3773df363fb1258',
    '.local/web2-native-private-practice-reviewed/manual-demo.ts': 'f872dab0b57eea52fcd7564f25be03c9cf3f7bc3b5c551c62b1b37816e3dcfff',
}

# The effective manual-browser.ts is not overridden by the close-instrumentation
# ISO; it reaches the guest through launcher-overlay.tar inside notes-entry.iso.
# This pin is the r19 packaged digest of that member.
ENTRY_OVERLAY_MANUAL_BROWSER_R19 = '24f3384bb962f80c07b4bfedfd3f34a48f01f711c37cd162cddbd9b7d936690e'


def iso_member(iso, member):
    result = subprocess.run(['isoinfo', '-i', str(iso), '-R', '-x', '/' + member],
                            check=True, capture_output=True)
    return result.stdout


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
    memory_mb = os.environ.get('PIRATE_VM_MEMORY_MB', '4096')
    assert memory_mb in {'4096', '8192'}, f'unaccepted diagnostic memory request {memory_mb}'
    if memory_mb != '4096':
        raw = replace(raw, '-m 4096', f'-m {memory_mb}')
        print(f'NON-QUALIFYING DIAGNOSTIC: guest memory {memory_mb} MiB replaces the qualifying 4096 MiB')
    runner.write_text(raw)
    runner.chmod(0o700)

    vendored_root = Path(__file__).resolve().parent / 'vm-final-runner'
    repinned = {}
    for name, sealed_pin in VENDORED_SEALED_R19.items():
        member = bundle / name
        actual = hashlib.sha256(member.read_bytes()).hexdigest()
        assert actual == sealed_pin, f'{name}: sealed member {actual} diverges from pinned r19 base {sealed_pin}'
        member.write_bytes((vendored_root / name).read_bytes())
        member.chmod(0o600)
        repinned[name] = hashlib.sha256(member.read_bytes()).hexdigest()

    close_iso = bundle / 'close-instrumentation.iso'
    for member, sealed_pin in CLOSE_ISO_SEALED_R19.items():
        actual = hashlib.sha256(iso_member(close_iso, member)).hexdigest()
        assert actual == sealed_pin, f'close-instrumentation.iso:{member} sealed {actual} diverges from pinned r19 base {sealed_pin}'
    overlay_bytes = iso_member(bundle / 'notes-entry.iso', 'launcher-overlay.tar')
    with tarfile.open(fileobj=io.BytesIO(overlay_bytes)) as overlay:
        browser_member = overlay.extractfile('.local/web2-native-private-practice-reviewed/manual-browser.ts')
        assert browser_member is not None
        actual = hashlib.sha256(browser_member.read()).hexdigest()
    assert actual == ENTRY_OVERLAY_MANUAL_BROWSER_R19, \
        f'notes-entry.iso launcher-overlay manual-browser.ts sealed {actual} diverges from pinned r19 base {ENTRY_OVERLAY_MANUAL_BROWSER_R19}'

    iso_root = scratch / 'close-iso-rebuild'
    demo_target = iso_root / '.local/web2-native-private-practice-reviewed/manual-demo.ts'
    browser_target = iso_root / '.local/web2-native-private-practice-reviewed/manual-browser.ts'
    controller_target = iso_root / 'controller/guest-notes-controller.py'
    demo_target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    controller_target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    demo_target.write_bytes((vendored_root / 'manual-demo.ts').read_bytes())
    browser_target.write_bytes((vendored_root / 'manual-browser.ts').read_bytes())
    controller_target.write_bytes((vendored_root / 'guest-notes-controller.py').read_bytes())
    demo_target.chmod(0o600)
    browser_target.chmod(0o600)
    controller_target.chmod(0o600)
    subprocess.run(['genisoimage', '-quiet', '-R', '-V', 'PRT_CLOSE', '-o', 'close-instrumentation.iso', '.'],
                   check=True, cwd=iso_root)
    rebuilt = iso_root / 'close-instrumentation.iso'
    close_iso.write_bytes(rebuilt.read_bytes())
    close_iso.chmod(0o600)
    repinned['close-instrumentation.iso'] = hashlib.sha256(close_iso.read_bytes()).hexdigest()

    bootstrap = bundle / 'guest-notes-bootstrap.sh'
    raw = bootstrap.read_text()
    demo_install = 'install -o 1000 -g 1000 -m 0600 "$close_diag/.local/web2-native-private-practice-reviewed/manual-demo.ts" "$checkout/.local/web2-native-private-practice-reviewed/manual-demo.ts"'
    browser_install = 'install -o 1000 -g 1000 -m 0600 "$close_diag/.local/web2-native-private-practice-reviewed/manual-browser.ts" "$checkout/.local/web2-native-private-practice-reviewed/manual-browser.ts"'
    raw = replace(raw, demo_install, demo_install + '\n' + browser_install)
    export_tail = 'notes-before.json binding-before.json notes-after.json binding-after.json)'
    raw = replace(raw, export_tail,
                  'notes-before.json binding-before.json notes-after.json binding-after.json native-progress.json native-memory.json)')
    bootstrap.write_text(raw)
    bootstrap.chmod(0o700)
    repinned['guest-notes-bootstrap.sh'] = hashlib.sha256(bootstrap.read_bytes()).hexdigest()

    manifest = bundle / 'NOTES-EXECUTION-SHA256SUMS'
    lines = []
    replaced = 0
    repinned['run-notes.sh'] = hashlib.sha256(runner.read_bytes()).hexdigest()
    for line in manifest.read_text().splitlines():
        pin, separator, name = line.partition('  ')
        assert separator
        if name in repinned:
            line = f'{repinned[name]}  {name}'
            replaced += 1
        lines.append(line)
    assert replaced == len(repinned)
    manifest.write_text('\n'.join(lines) + '\n')
    manifest.chmod(0o600)
    print('Final CI runner adapted')


if __name__ == '__main__':
    main()
