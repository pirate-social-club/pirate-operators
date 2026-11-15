#!/usr/bin/env python3
"""Linux audit supervisor; reap owned browser descendants across process groups."""
from pathlib import Path
import argparse,ctypes,datetime,json,os,signal,subprocess,time

def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()

def parse_process_stat(raw,pid):
    # comm is arbitrary bytes and may contain ') ', newlines or non-UTF8.
    # All fields after the final delimiter are kernel-provided ASCII values.
    try:
        head,delimiter,tail=raw.rpartition(b') ')
        if not delimiter or not head.startswith(str(pid).encode('ascii')+b' ('):
            return None
        fields=tail.split()
        if len(fields)<20 or len(fields[0])!=1:
            return None
        parent,group,start=int(fields[1]),int(fields[2]),int(fields[19])
        if min(parent,group,start)<0:
            return None
        return {'parent':parent,'group':group,'startTicks':str(start),'state':fields[0].decode('ascii')}
    except (ValueError,TypeError,IndexError,UnicodeError,AttributeError):
        return None

def process_info(pid):
    try:
        return parse_process_stat(Path('/proc',str(pid),'stat').read_bytes(),pid)
    except OSError:
        # Races, permissions and malformed individual entries cannot abort
        # the remaining ownership scan or its cleanup.
        return None

def descendants():
    table={}
    for item in Path('/proc').iterdir():
        if item.name.isdigit():
            info=process_info(int(item.name))
            if info is not None:
                table[int(item.name)]=info
    owned={os.getpid()}
    while True:
        found={pid for pid,info in table.items() if info['parent'] in owned}
        if found<=owned:
            break
        owned|=found
    return {pid:table[pid] for pid in owned if pid!=os.getpid()}

def signal_owned(sig):
    signaled=[]
    for pid,known in descendants().items():
        current=process_info(pid)
        if current and current['startTicks']==known['startTicks'] and current['state']!='Z':
            try:
                os.kill(pid,sig)
                signaled.append({'pid':pid,'startTicks':known['startTicks'],'signal':sig})
            except ProcessLookupError:
                pass
    return signaled

def reap():
    while True:
        try:
            pid,_=os.waitpid(-1,os.WNOHANG)
            if pid==0:
                break
        except ChildProcessError:
            break

def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--timeout-seconds',type=int,required=True)
    parser.add_argument('--receipt',required=True)
    parser.add_argument('command',nargs=argparse.REMAINDER)
    args=parser.parse_args(argv)
    if args.command[:1]==['--']:
        args.command=args.command[1:]
    if not 6<=args.timeout_seconds<=1200 or not args.command:
        parser.error('Use a6..1200s total bound and a command after --')
    receipt=Path(args.receipt)
    if not receipt.is_absolute():
        parser.error('Use an absolute fresh receipt path')
    record={'startedAt':now(),'passed':False,'command':args.command,'totalBoundSeconds':args.timeout_seconds}
    # Exclusive creation cannot overwrite another run, even on startup failure.
    with receipt.open('x') as output:
        output.write(json.dumps(record)+'\n');output.flush()
        received=[];previous={};child=None;started=time.monotonic()
        try:
            if ctypes.CDLL(None).prctl(36,1,0,0,0)!=0:
                raise RuntimeError('Linux child subreaper unavailable')
            record['supervisorPid']=os.getpid()
            for sig in [signal.SIGINT,signal.SIGTERM]:
                previous[sig]=signal.signal(sig,lambda number,_frame:received.append(number))
            child=subprocess.Popen(args.command,start_new_session=True)
            info=process_info(child.pid)
            record['driver']={'pid':child.pid,**(info or {})}
            deadline=started+args.timeout_seconds-5
            while child.poll() is None and not received and time.monotonic()<deadline:
                time.sleep(.025)
            record['childExitCode']=child.poll()
            record['timedOut']=child.returncode is None and not received
        except BaseException as error:
            record['error']={'name':type(error).__name__,'message':str(error)}
        finally:
            # The driver may already have exited: subreaper adoption retains its
            # detached browser children as this supervisor's responsibility.
            if child is not None:
                child.poll()
            reap()
            before=descendants()
            record['ownedBeforeCleanup']=before
            record['unexpectedLiveDescendants']=any(info['state']!='Z' for info in before.values())
            record['signals']=signal_owned(signal.SIGTERM)
            deadline=time.monotonic()+1
            while descendants() and time.monotonic()<deadline:
                reap();time.sleep(.025)
            record['signals']+=signal_owned(signal.SIGKILL)
            deadline=time.monotonic()+2
            while descendants() and time.monotonic()<deadline:
                record['signals']+=signal_owned(signal.SIGKILL)
                reap();time.sleep(.025)
            reap()
            record['allOwnedChildrenAbsent']=not descendants()
            record['receivedSignals']=received
            record['elapsedSeconds']=time.monotonic()-started
            record['passed']=bool(record.get('childExitCode')==0 and not record.get('timedOut') and not record.get('error') and not received and not record['unexpectedLiveDescendants'] and record['allOwnedChildrenAbsent'] and record['elapsedSeconds']<=args.timeout_seconds)
            record['finishedAt']=now()
            output.seek(0);output.truncate();output.write(json.dumps(record,indent=2)+'\n');output.flush()
            for sig,handler in previous.items():
                signal.signal(sig,handler)
    return 0 if record['passed'] else 1

if __name__=='__main__':
    raise SystemExit(main())
