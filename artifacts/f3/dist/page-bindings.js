/** Bind an EXISTING page to F3 operations. No native alert/confirm/prompt, no mock mode. */
import { check, kasToSompi, unhex } from './bytes.js';
import { acquirePassA } from './pass-a.js';
/** Plug into PageContext.drawProof; provider is browserPassAProvider(rest, SDK RPC, LaneProofRpc).
 * Refresh verifies the current snapshot before any proof request; the contract's
 * OpChainblockSeqCommit remains the final chain-membership check at spend.
 */
export function createPassADrawProof(api, provider) {
    return async (round) => {
        const snap = await api.refresh(round);
        const proof = await acquirePassA(snap, api.profile, provider);
        return { opening: proof.opening, accessor: { blockHash: proof.target.hash, sequenceCommitment: proof.target.seqCommit } };
    };
}
export function bindKaswinPage(root, api, context) {
    const controller = new AbortController();
    const status = root.querySelector('[data-kaswin-status]');
    const show = (value) => { if (status)
        status.textContent = value; };
    root.addEventListener('submit', async (event) => {
        const form = event.target;
        if (!(form instanceof HTMLFormElement) || !form.matches('[data-kaswin-action]'))
            return;
        event.preventDefault();
        const action = form.dataset.kaswinAction;
        const controls = [...form.querySelectorAll('button,input,select')];
        const data = new FormData(form), round = String(data.get('genesisTxId') ?? '').trim();
        try {
            controls.forEach(c => c.disabled = true);
            show('Preparing transaction');
            unhex(round, 32);
            const actorKey = context.actorKey(), op = { action, actorKey };
            if (action === 'BUY') {
                const q = String(data.get('quantity') ?? '');
                check(/^[1-9][0-9]*$/.test(q), 'QUANTITY');
                op.quantity = Number(q);
            }
            if (action === 'DRAW' || action === 'DRAW_AND_PAY')
                Object.assign(op, await context.drawProof(round));
            const auth = { maxNetworkFee: kasToSompi(String(data.get('maxFeeKas') ?? '')), maxWalletDebit: kasToSompi(String(data.get('maxDebitKas') ?? '')) };
            const p = await api.prepare(round, op, await context.funds(action), context.budget(action), auth, controller.signal);
            const r = await api.execute(p, { approve: context.approve, signal: controller.signal });
            show(`${r.status} ${r.txid}${r.syncPending ? ' | state refresh pending' : ''}${r.refreshError ? ' | ' + r.refreshError : ''}${r.transportError ? ' | ' + r.transportError : ''}`);
            root.dispatchEvent(new CustomEvent('kaswin:receipt', { detail: r }));
        }
        catch (e) {
            show(e instanceof Error ? e.message : String(e));
        }
        finally {
            controls.forEach(c => c.disabled = false);
        }
    }, { signal: controller.signal });
    return () => controller.abort();
}
//# sourceMappingURL=page-bindings.js.map