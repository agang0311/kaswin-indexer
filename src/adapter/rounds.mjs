// Adapter for a locally pinned F3 profile. Never load templates or profile from an indexer response.
export function createRoundAdapter({S,P,G,B,H,profile,registryScope=[],registrationOf=null}) {
 const hex=b=>Buffer.from(b).toString('hex'),bytes=h=>new Uint8Array(Buffer.from(h,'hex'));
 const eq=(ok,msg)=>{if(!ok)throw Error(msg)};
 const spk=x=>typeof x==='string'?{version:parseInt(x.slice(0,4).match(/../g).reverse().join(''),16),script:x.slice(4)}:x;
 const serial=x=>JSON.parse(JSON.stringify(x,(_,v)=>typeof v==='bigint'?v.toString():v instanceof Uint8Array?hex(v):v));
 const outpoint=(a,b)=>a?.transactionId===b?.transactionId&&a.index===b.index;
 function snap(r,daa){return {ledger:bytes(r.ledger),tip:r.tip,scriptPublicKey:r.spk,covenantId:r.cid,value:BigInt(r.value),utxoDaa:BigInt(r.utxoDaa),currentDaa:BigInt(daa),origin:r.origin};}
 function summary(r){const s=S.decodeLedger(bytes(r.ledger));return {...r,state:serial({...s,directory:undefined}),purchases:S.records(s),profileId:profile.id,requiresIndependentVerification:true};}
 function genesis(t,b){
  const prefix=Buffer.from('KASWIN_F3_GENESIS').toString('hex');if(!t.payload?.startsWith(prefix))return null;
  // Other profiles/invalid announcements are not rounds. They are never allowed to mutate existing rounds.
  const o=t.outputs?.[0],c=o?.covenant;if(!c)return null;
  try{
   const s=G.verifyGenesisAnnouncement({accepted:true,payload:t.payload,authorizingOutpoint:t.inputs[0].previousOutpoint,
    outputIndex:0,value:BigInt(o.value),spk:spk(o.scriptPublicKey),covenantId:c.covenantId,authorizingInput:c.authorizingInput,
    covenantOutputIndices:t.outputs.flatMap((v,i)=>v.covenant?.covenantId===c.covenantId?[i]:[])},profile);
   const id=t.verboseData.transactionId;
   const candidate=registrationOf?.(t,registryScope,s.ownerKey)??null;
   const funding=t.inputs?.[0],utxo=funding?.verboseData?.utxoEntry;
   // A matching marker with incomplete node funding context is UNKNOWN: stop
   // without advancing the cursor, never silently drop an otherwise valid round.
   if(candidate&&t.inputs.length===1&&(!utxo||typeof utxo.amount==='undefined'||typeof utxo.scriptPublicKey!=='string'||typeof funding.signatureScript!=='string'))throw Error('F31_FUNDING_CONTEXT_MISSING');
   // This checks canonical F3.1 creator funding shape, not cryptographic signature
   // verification; accepted-chain nodes enforce that independently.
   const ownFunding=candidate&&t.inputs?.length===1&&/^41[0-9a-f]{128}01$/i.test(funding.signatureScript??'')&&utxo?.isCoinbase===false&&
     utxo?.scriptPublicKey===`000020${s.ownerKey}ac`&&!utxo.covenantId&&
     t.outputs.every((o,i)=>i===0||!o.covenant)&&t.outputs.reduce((n,o)=>n+BigInt(o.value),0n)<BigInt(utxo.amount);
   const registration=ownFunding?candidate:null;
   const creation=registration?{schema:'F3.1',genesisTxid:id,acceptingBlock:b.hash,acceptingDaa:b.daa,containingBlock:t.verboseData.blockHash,profileId:profile.id,networkGenesis:profile.networkGenesis,cid:c.covenantId,origin:t.inputs[0].previousOutpoint,config:serial(s.config),registration,genesisTransaction:serial(t),verifiedF3Genesis:true}:undefined;
   return summary({id,genesisTxid:id,creation,genesisAccepting:b.hash,genesisContaining:t.verboseData.blockHash,
    genesisTransaction:serial(t),latestTxid:id,latestTransaction:serial(t),accepting:b.hash,containing:t.verboseData.blockHash,
    tip:{transactionId:id,index:0},origin:t.inputs[0].previousOutpoint,cid:c.covenantId,ledger:hex(S.encodeLedger(s)),spk:spk(o.scriptPublicKey),value:String(o.value),utxoDaa:b.daa,terminal:null});
  }catch(e){if(String(e.message)==='F31_FUNDING_CONTEXT_MISSING')throw e;return null;}
 }
 function pushes(script){
  const data=bytes(script),result=[];let p=0;
  while(p<data.length){let op=data[p++],n;
   if(op===0){result.push(new Uint8Array());continue;}
   if(op>=81&&op<=96){result.push(Uint8Array.of(op-80));continue;}
   if(op<=75)n=op;else if(op>=76&&op<=78){const width=op===76?1:op===77?2:4;eq(p+width<=data.length,'PUSH_HEADER');n=0;for(let j=0;j<width;j++)n+=data[p++]*2**(8*j);}else throw Error('NON_PUSH_WITNESS');
   eq(n<=250000&&p+n<=data.length,'PUSH_SIZE');result.push(data.slice(p,p+n));p+=n;
  }return result;
 }
 function integer(data){eq(data.length<=8&&(!data.length||!(data.at(-1)&128)),'SCRIPT_INT');let n=0n;for(let i=data.length-1;i>=0;i--)n=(n<<8n)+BigInt(data[i]);return n;}
 function advance(r,t,b){
  eq(outpoint(t.inputs?.[0]?.previousOutpoint,r.tip),'ROUND_INPUT_NOT_ZERO');
  const x=snap(r,b.daa),s=S.verifySnapshot(x,profile),w=pushes(t.inputs[0].signatureScript);
  eq(w.length===11,'F3_WITNESS_ABI');
  const action=Object.keys(P.ACTIONS).find(k=>BigInt(P.ACTIONS[k])===integer(w[0]));eq(action,'UNKNOWN_ACTION');
  eq(hex(w[1])===r.origin.transactionId&&integer(w[2])===BigInt(r.origin.index),'ORIGIN_CHANGED');
  eq(hex(w[10])===hex(S.scriptOf(s,profile)),'REDEEM_SCRIPT_MISMATCH');
  const fee=integer(w[8]),outputSum=t.outputs.reduce((n,o)=>n+BigInt(o.value),0n),external=outputSum+fee-x.value;
  const op={action,actorKey:hex(w[7])};
  if(action==='BUY'){eq(w[6].length===4,'BUY_DATA');op.quantity=Number(integer(w[6]));}
  if(action==='DRAW'||action==='DRAW_AND_PAY'){
   const opening=w[6].slice(0,240);eq(opening.length===240,'DRAW_PROOF');
   // Recompute the commitment from the supplied opening. Selected-chain membership is
   // established by the node's acceptance of the authenticated covenant, NOT this local recomputation.
   const branch=(a,c)=>B.domainHash('SeqCommitmentMerkleBranchHash',new Uint8Array([...a,...c]));
   const seq=(base,parent)=>branch(parent,branch(opening.slice(base,base+32),branch(B.domainHash('SeqCommitMergesetContext',opening.slice(base+64,base+88)),opening.slice(base+32,base+64))));
   const commitment=seq(32,seq(152,opening.slice(120,152)));
   op.opening=opening;op.accessor={blockHash:hex(opening.slice(0,32)),sequenceCommitment:hex(commitment)};
  }
  const transition=P.transition(x,profile,op,fee,external),module=S.phaseModule(s.phase),frame=profile.frames[module];
  eq(integer(w[3])===BigInt(frame.tail.length)&&hex(w[4])===(module==='open'?'':hex(profile.frames.open.tail))&&hex(w[5])===hex(transition.foreignTail)&&hex(w[6])===hex(transition.data)&&hex(w[9])===frame.dispatchTag,'WITNESS_POLICY_MISMATCH');
  eq(BigInt(t.lockTime)===transition.lockTime&&BigInt(t.inputs[0].sequence)===transition.sequence,'TIME_FIELDS');
  const expected=[];if(transition.next){const script=S.scriptOf(transition.next,profile);expected.push({value:S.valueOf(transition.next),spk:{version:0,script:'aa20'+hex(H.blake2b256(script))+'87'},cid:r.cid});}
  for(const p of transition.payments)expected.push({value:p.value,spk:p.spk,cid:null});
  eq(t.outputs.length===expected.length,'OUTPUT_COUNT');
  t.outputs.forEach((o,i)=>{const e=expected[i],k=spk(o.scriptPublicKey);eq(BigInt(o.value)===e.value&&k.version===e.spk.version&&k.script===e.spk.script&&(o.covenant?.covenantId??null)===e.cid&&(!e.cid||o.covenant.authorizingInput===0),'OUTPUT_MISMATCH');});
  const id=t.verboseData.transactionId;
  const next={...r,latestTxid:id,latestTransaction:serial(t),accepting:b.hash,containing:t.verboseData.blockHash,terminal:transition.terminal,
   tip:transition.next?{transactionId:id,index:0}:null,ledger:transition.next?hex(S.encodeLedger(transition.next)):r.ledger,
   spk:transition.next?expected[0].spk:r.spk,value:transition.next?expected[0].value.toString():'0',utxoDaa:b.daa};
  if(next.tip)S.verifySnapshot(snap(next,b.daa),profile);
  return summary(next);
 }
 function project(rounds,blocks){const map=new Map(rounds.map(r=>[r.id,r]));const changes=[];
  for(const b of blocks){const undo=new Map();for(const tx of b.transactions){const t=tx.raw;
    const touched=[...map.values()].filter(r=>r.tip&&t.inputs.some(i=>outpoint(i.previousOutpoint,r.tip)));
    eq(touched.length<=1,'MULTIPLE_ROUNDS_UNSUPPORTED');
    if(touched.length){const old=touched[0];if(!undo.has(old.id))undo.set(old.id,old);map.set(old.id,advance(old,t,b));}
    else{const r=genesis(t,b);if(r){eq(!map.has(r.id),'DUPLICATE_GENESIS');if(!undo.has(r.id))undo.set(r.id,null);map.set(r.id,r);}}
   }
   changes.push({hash:b.hash,daa:b.daa,updates:[...undo].map(([id,previous])=>({id,previous,current:map.get(id)}))});
  }return {rounds:[...map.values()],blocks:changes};
 }
 return {genesis,advance,project,summary};
}
