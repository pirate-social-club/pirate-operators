import assert from "node:assert/strict";
import {test} from "node:test";
import {requireGenuineProducer} from "../deploy/linux/shared-v2-result-producer.ts";
test("legacy declaration or fake structural port does not supply a selected native producer",()=>{
 assert.throws(()=>requireGenuineProducer({policy:"pirate.linux-journal-capacity/1"} as never,{} as never,"0x"+"a".repeat(64)),
  {message:"selected_native_producer_required"});
});
// Negative only; no fake complete backend or ready row is accepted.
