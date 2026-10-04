// F3.1 registration is an optional ordinary Genesis output, never a covenant authorization.
export const DEFAULT_REGISTRY_ADDRESS='kaspatest:qztrjpfpuf6g9jw76e6ay909z43hndpv5maqkker6ur4enz7llarsh82ezggl';
export const REGISTRATION_SOMPI='5000000';
export function registryScope(sdk,addresses){
 if(!Array.isArray(addresses)||addresses.length<1||addresses.length>16||new Set(addresses).size!==addresses.length)throw Error('REGISTRY_ADDRESSES');
 return addresses.map(address=>{
  if(typeof address!=='string'||!address.startsWith('kaspatest:')||address.length>120)throw Error('REGISTRY_TN10_ADDRESS');
  const a=new sdk.Address(address);try{
   const p=sdk.payToAddressScript(a);try{
    if(sdk.addressFromScriptPublicKey(p,'testnet-10').toString()!==address)throw Error('REGISTRY_ADDRESS_ROUNDTRIP');
    return {address,spk:{version:p.version,script:p.script}};
   }finally{p.free?.();}
  }finally{a.free?.();}
 });
}
const wireSpk=p=>typeof p==='string'?p:/^[0-9a-f]*$/.test(p?.script??'')&&Number.isInteger(p?.version)&&p.version>=0&&p.version<=65535?p.version.toString(16).padStart(4,'0').match(/../g).reverse().join('')+p.script:null;
export function registrationOf(tx,scope,ownerKey){
 const outputs=tx.outputs??[];
 // Only the canonical payment slot is accepted. A lookalike payment elsewhere
 // is not F3.1 registration. Genesis/profile/consensus must be checked separately.
 const o=outputs[1],spk=o?.scriptPublicKey;
 // F3.1 canonical builder produces only Genesis + registration + optional owner change.
 if(outputs.length!==2&&outputs.length!==3)return null;
 if(outputs.length===3){const change=outputs[2];
  if(!ownerKey||!/^[1-9][0-9]*$/.test(String(change.value))||change.covenant||wireSpk(change.scriptPublicKey)!=='000020'+ownerKey+'ac')return null;
 }
 const match=scope.filter(r=>String(o?.value)===REGISTRATION_SOMPI&&wireSpk(spk)===wireSpk(r.spk)&&!o?.covenant);
 if(match.length!==1)return null;
 return {address:match[0].address,outpoint:{transactionId:tx.verboseData.transactionId,index:1},amountSompi:REGISTRATION_SOMPI,spk:match[0].spk};
}
