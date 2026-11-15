#!/usr/bin/env python3
"""Synthetic process-lifetime regressions with independent fixture custody."""
from pathlib import Path
import ctypes,importlib.util,json,os,signal,subprocess,sys,tempfile,time,unittest
from unittest import mock
sys.dont_write_bytecode=True
SUPERVISOR=Path(__file__).with_name('supervise-audit.py')
SPEC=importlib.util.spec_from_file_location('storybook_supervisor_under_test',SUPERVISOR)
MODULE=importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)

FIXTURE=r"""
import ctypes,json,os,pathlib,signal,sys,time
mode,path=sys.argv[1:]
ctypes.CDLL(None).prctl(15,ctypes.c_char_p(b'a) b'),0,0,0)
parent=os.getpid()
parent_start=pathlib.Path('/proc/self/stat').read_bytes().rpartition(b') ')[2].split()[19].decode('ascii')
pathlib.Path(path+'.driver.json').write_text(json.dumps({'pid':parent,'startTicks':parent_start}))
pid=os.fork()
if pid==0:
 os.setsid()
 if mode=='double':
  if os.fork()!=0:os._exit(0)
 ctypes.CDLL(None).prctl(15,ctypes.c_char_p(b'bad) \xff'),0,0,0)
 signal.signal(signal.SIGTERM,signal.SIG_IGN)
 fields=pathlib.Path('/proc/self/stat').read_bytes().rpartition(b') ')[2].split()
 pathlib.Path(path).write_text(json.dumps({'pid':os.getpid(),'startTicks':fields[19].decode('ascii'),'group':os.getpgrp(),'driver':parent,'driverStartTicks':parent_start}))
 while True:time.sleep(1)
if mode=='exit':
 while not pathlib.Path(path).exists():time.sleep(.01)
 os._exit(0)
signal.signal(signal.SIGTERM,signal.SIG_IGN)
while True:time.sleep(1)
"""
def probe(pid):
 # Test custody deliberately does not call the supervisor implementation.
 try:
  raw=Path('/proc',str(pid),'stat').read_bytes()
  tail=raw[raw.rfind(b') ')+2:].split()
  return {'pid':pid,'parent':int(tail[1]),'startTicks':tail[19].decode('ascii'),'state':tail[0]}
 except (OSError,ValueError,IndexError,UnicodeError):return None

def alive(info):
 current=probe(info['pid'])
 return bool(current and current['startTicks']==info['startTicks'])

class FixtureCustody:
 def __init__(self):
  if ctypes.CDLL(None).prctl(36,1,0,0,0)!=0:raise RuntimeError('Test child subreaper unavailable')
  self.processes=[];self.identities={}
 def remember(self,info):
  if info:self.identities[(info['pid'],info['startTicks'])]=dict(info)
 def track(self,proc):
  self.processes.append(proc);self.remember(probe(proc.pid));return proc
 def refresh(self):
  table={}
  for item in Path('/proc').iterdir():
   if item.name.isdigit():
    info=probe(int(item.name))
    if info:table[info['pid']]=info
  owned={os.getpid()}
  while True:
   more={pid for pid,info in table.items() if info['parent'] in owned}
   if more<=owned:break
   owned|=more
  for pid in owned-{os.getpid()}:self.remember(table[pid])
 def cleanup(self):
  # Subreaper adoption and the independent ledger survive a killed supervisor,
  # failed assertion and fixtures that detached before their readiness file.
  started=time.monotonic();deadline=started+4
  while time.monotonic()<deadline:
   self.refresh()
   for proc in self.processes:proc.poll()
   for info in list(self.identities.values()):
    current=probe(info['pid'])
    if current and current['startTicks']==info['startTicks'] and current['state']!=b'Z':
     try:os.kill(info['pid'],signal.SIGTERM if time.monotonic()-started<.2 else signal.SIGKILL)
     except ProcessLookupError:pass
   while True:
    try:
     pid,_=os.waitpid(-1,os.WNOHANG)
     if not pid:break
    except ChildProcessError:break
   self.refresh()
   if not any(alive(info) for info in self.identities.values()):break
   time.sleep(.02)
  for proc in self.processes:
   proc.poll()
   for stream in [proc.stdout,proc.stderr]:
    if stream and not stream.closed:stream.close()
  return [info for info in self.identities.values() if alive(info)]
 def __enter__(self):return self
 def __exit__(self,*_):
  remaining=self.cleanup()
  if remaining:raise AssertionError('Fixture cleanup left owned identities: '+repr(remaining))

def await_fixture(info,proc,custody):
 limit=time.monotonic()+3;data=None
 while time.monotonic()<limit:
  for path in [Path(str(info)+'.driver.json'),info]:
   try:
    value=json.loads(path.read_text());custody.remember(value)
    if path==info:data=value
   except (FileNotFoundError,json.JSONDecodeError):pass
  custody.refresh()
  if data is not None:break
  if proc.poll() is not None:break
  time.sleep(.01)
 if data:
  custody.remember({'pid':data['driver'],'startTicks':data['driverStartTicks']})
 return data

def raw_stat(comm,pid=321):
 fields=[b'S',b'12',b'321']+[b'0']*16+[b'987']
 return str(pid).encode()+b' ('+comm+b') '+b' '.join(fields)+b'\n'

class StatParsingCases(unittest.TestCase):
 def test_legal_comm_containing_closing_delimiter(self):
  actual=MODULE.parse_process_stat(raw_stat(b'a) b'),321)
  self.assertEqual(actual,{'parent':12,'group':321,'startTicks':'987','state':'S'})
 def test_non_utf8_newline_and_repeated_delimiters_in_comm(self):
  self.assertEqual(MODULE.parse_process_stat(raw_stat(b'a) \xff\n) b'),321)['startTicks'],'987')
 def test_truncated_malformed_and_foreign_pid_return_none(self):
  for raw,pid in [(b'truncated',321),(raw_stat(b'ok'),999),(raw_stat(b'ok').replace(b' 12 ',b' nope ',1),321)]:
   self.assertIsNone(MODULE.parse_process_stat(raw,pid))
 def test_individual_proc_read_error_does_not_escape(self):
  with mock.patch.object(MODULE.Path,'read_bytes',side_effect=OSError('vanished')):
   self.assertIsNone(MODULE.process_info(321))

class SupervisorCases(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory(prefix='storybook-supervisor-')
  self.root=Path(self.tmp.name);self.custody=FixtureCustody()
 def tearDown(self):
  remaining=self.custody.cleanup()
  self.assertEqual(remaining,[],'Fixture fallback cleanup failed: '+repr(remaining))
  self.tmp.cleanup()
 def launch(self,command):
  receipt=self.root/'supervisor.json'
  proc=self.custody.track(subprocess.Popen([sys.executable,'-B',str(SUPERVISOR),'--timeout-seconds','6','--receipt',str(receipt),'--',*command],stdout=subprocess.PIPE,stderr=subprocess.PIPE))
  return proc,receipt
 def finish(self,proc,receipt):
  stdout,stderr=proc.communicate(timeout=12)
  self.assertTrue(receipt.exists(),stderr.decode())
  record=json.loads(receipt.read_text())
  self.assertTrue(record['allOwnedChildrenAbsent'],record)
  return proc.returncode,record
 def fixture(self,mode):
  info=self.root/'fixture.json'
  proc,receipt=self.launch([sys.executable,'-c',FIXTURE,mode,str(info)])
  data=await_fixture(info,proc,self.custody)
  self.assertIsNotNone(data)
  self.assertNotEqual(data['pid'],data['group'] if mode=='double' else data['driver'])
  return proc,receipt,data
 def test_clean_child_success(self):
  proc,receipt=self.launch([sys.executable,'-c','pass'])
  code,result=self.finish(proc,receipt)
  self.assertEqual(code,0);self.assertTrue(result['passed'])
 def test_nonzero_child_cannot_pass(self):
  proc,receipt=self.launch([sys.executable,'-c','raise SystemExit(7)'])
  code,result=self.finish(proc,receipt)
  self.assertNotEqual(code,0);self.assertEqual(result['childExitCode'],7)
 def test_timeout_reaps_detached_term_ignoring_child(self):
  proc,receipt,child=self.fixture('wait')
  code,result=self.finish(proc,receipt)
  self.assertNotEqual(code,0);self.assertTrue(result['timedOut']);self.assertFalse(alive(child))
 def test_successful_driver_cannot_leave_detached_browser_alive(self):
  proc,receipt,child=self.fixture('exit')
  code,result=self.finish(proc,receipt)
  self.assertNotEqual(code,0);self.assertEqual(result['childExitCode'],0)
  self.assertTrue(result['unexpectedLiveDescendants']);self.assertFalse(alive(child))
 def test_sigterm_of_supervisor_reaps_other_process_group(self):
  proc,receipt,child=self.fixture('wait')
  proc.send_signal(signal.SIGTERM)
  code,result=self.finish(proc,receipt)
  self.assertNotEqual(code,0);self.assertIn(signal.SIGTERM,result['receivedSignals']);self.assertFalse(alive(child))
 def test_double_fork_adoption_is_owned_after_parent_exit(self):
  proc,receipt,child=self.fixture('double')
  code,result=self.finish(proc,receipt)
  self.assertNotEqual(code,0);self.assertFalse(alive(child))
 def test_unrelated_process_is_preserved(self):
  witness=self.custody.track(subprocess.Popen([sys.executable,'-c','import time;time.sleep(60)']))
  proc,receipt,child=self.fixture('wait')
  self.finish(proc,receipt)
  self.assertIsNone(witness.poll());self.assertFalse(alive(child))
 def test_receipt_collision_preserves_previous_evidence(self):
  receipt=self.root/'supervisor.json';receipt.write_text('previous sealed receipt')
  proc,_=self.launch([sys.executable,'-c','raise SystemExit(99)'])
  proc.communicate(timeout=3)
  self.assertNotEqual(proc.returncode,0);self.assertEqual(receipt.read_text(),'previous sealed receipt')
 def test_spawn_failure_retains_failed_receipt(self):
  proc,receipt=self.launch(['/no/such/executable'])
  code,result=self.finish(proc,receipt)
  self.assertNotEqual(code,0);self.assertIn('error',result)
 def test_independent_custody_reaps_after_supervisor_sigkill(self):
  proc,receipt,child=self.fixture('wait')
  proc.kill();proc.wait(timeout=3)
  self.assertEqual(self.custody.cleanup(),[])
  self.assertFalse(alive(child))
 def test_independent_custody_reaps_on_assertion_before_normal_cleanup(self):
  data=None
  with self.assertRaisesRegex(AssertionError,'intentional fixture failure'):
   with FixtureCustody() as fallback:
    info=self.root/'aborted-fixture.json'
    proc=fallback.track(subprocess.Popen([sys.executable,'-c',FIXTURE,'wait',str(info)]))
    data=await_fixture(info,proc,fallback)
    self.assertIsNotNone(data)
    raise AssertionError('intentional fixture failure')
  self.assertFalse(alive(data))

if __name__=='__main__':
 unittest.main()
