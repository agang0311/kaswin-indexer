# Kaswin V2 链上源码候选（目录暂保留 f3.2）

**当前为新V2 Profile `7aaf76fe5e2180070290ff984bebaef54e41093e6a77eef24f2b48fb64c159c8`。** 2026-10-07合约收紧并固定编译/逆拓扑重编一致：所有动作fee=真实输入输出差，0<fee≤50000000；退款末输出绑定actor/P2PK/金额/无CID；超时432000 DAA。ABI和Header不变，不迁移旧UTXO。`budgetProfileId:null`，默认交易发布BLOCKED，仅允许明确禁用交易的只读候选。未VM／链上测试。[Preflight与结果](../../docs/kaswin-v2/CONTRACT-HARDENING-20261007.md)。

| 文件 | 责任 |
|---|---|
| [src/open.sil](src/open.sil) | BUY/CLOSE；唯一链上规范零票初态CID认证；写死SEALED/REFUNDING模板哈希 |
| [src/sealed.sil](src/sealed.sil) | 原子开奖派奖或432000 DAA超时转REFUNDING；只含REFUNDING前向哈希 |
| [src/refunding.sil](src/refunding.sil) | 分批退款/终局退押金／绑定执行者末输出；无foreign依赖 |
| [tools/linking.mjs](tools/linking.mjs) | 本地V2依赖/源码/artifact/ABI/Profile溯源加载，拒绝旧产物贴标签 |
| [tools/build-v2.mjs](tools/build-v2.mjs) | REFUNDING→SEALED→OPEN链接，只写新候选目录，不安装或发布 |
| [tools/check-compile.mjs](tools/check-compile.mjs) | 对已安装本地V2 bundle做逆拓扑重编比对，不支持旧部署 |

Header=228B、Magic=KW20、目录从228起；OPEN 8参数，SEALED/REFUNDING 6参数。零票初态使用PUSHDATA1 `4c e4`，首条记录264B使用PUSHDATA2。全零模板哈希仅为待注入占位；不能直接用silverc编译模板后发布。

固定SilverScript v1.0.0：`3ed973335b59269293564805cc2c58a14595ec03`，binary SHA256 `81de9aa4157dbde3633ebab629e86c5975770fc13ee2d2093e52d7f725616a00`。不升级工具链。

## 版本及发布顺序（执行验证须另获授权）

1. 固定TypeScript 5.8.3重新生成核心lib，不手改生成物。
2. `node contracts/f3.2/tools/build-v2.mjs /absolute/silverc /absolute/new-bundle-directory`。
3. 人工审查源码、依赖、ABI、产物与Profile，再安装候选bundle；脚本不自动安装。
4. V2真实VM正负例、mass/fee/预算校准；评审后才可设置对应的budgetProfileId及budgetEvidenceSha256。`tools/budget-gate.mjs`还核对编译器/共识pin、protocol/builders源码hash、日志hash、动作／目录／退款游标覆盖与实际默认预算；不接受只改Profile字符串放行。
5. 网页构建与最小回归。网络实验另行授权。

只有编译成功不代表VM、最大目录或TN10 acceptance通过。[源码状态与验证计划](../../docs/kaswin-v2/V2-SOURCE-STATUS.md)优先于旧整理文档中的历史结论。
