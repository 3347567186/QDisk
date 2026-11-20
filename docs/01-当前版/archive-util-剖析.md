# `src/src-tauri/src/archive/util.rs` 剖析

写于 1.42.6 之后。目的：在动手之前先搞清楚这个文件到底是什么、谁在用、动它会牵扯到谁。

当前状态：598 行，23 个公开项（2 个常量、1 个结构体、1 个枚举、1 个源项结构体、18 个函数）。

---

## 一、一句话定位

它不是「工具函数集合」，它是**整个压缩包模块的安全边界 + 进度总线 + 编码适配层**三件事挤在一个文件里。

这三个职责的变更频率完全不同：

| 职责 | 代表 | 什么时候会变 | 变错的后果 |
|---|---|---|---|
| 安全边界 | `safe_relative` / `safe_join` / `resolve_dest` / `MAX_TOTAL_UNPACKED` | 极少变，一旦变就要审 | 写到目录外、覆盖用户文件、磁盘写满 |
| 进度总线 | `Progress` / `copy_cancellable` | 几乎不变 | 界面卡住或进度条不动 |
| 编码适配 | `decode_ansi` / `utf16_to_string` / `to_wide` / `wide_path` / `filetime_to_local_parts` | 只在遇到具体乱码时才变 | 中文文件名乱码、时间显示错 |

挤在一起的实际代价：**改动安全边界的人，必须先读懂进度总线和编码适配**。反过来也一样。这是这个文件最该拆的地方，也是最不该现在拆的地方（见第六节）。

---

## 二、谁在用它

除 `Progress` 外，每一个导出项都有活调用者（上一轮已经删掉了 4 个没人用的）。依赖关系如下：

```
                     util.rs
                        │
   ┌──────────┬─────────┼─────────┬──────────┬─────────────┐
   │          │         │         │          │             │
 mod.rs    zip_impl   tar_impl  sevenz_impl  rar.rs    download.rs
   │          │         │         │          │             │
 命令层     ZIP 读写    TAR 读写   7Z 读写    RAR 读取    RAR DLL 下载
```

逐项调用者（`src/src-tauri/src/archive/*.rs` 内实测，去掉注释行）：

| 导出项 | 调用者 | 说明 |
|---|---|---|
| `Progress` | mod.rs 19、zip 29、tar 25、sevenz 15、rar 6 | 所有五个实现都靠它报进度，事件名 `archive-progress` |
| `Overwrite` | mod.rs 4、zip 13、tar 3、sevenz 2、rar 2 | 前端三档覆盖策略的 Rust 表示 |
| `resolve_dest` | zip 3、tar 3、sevenz 2、rar 2 | 每个解压路径都会过它 |
| `safe_join` | zip 5、tar 4、sevenz 3 | 解压落点，**安全边界** |
| `safe_relative` | rar 4、preview 2 | RAR 与预览不走 `safe_join`，单独用这一层 |
| `ensure_parent` | zip 3、tar 3、sevenz 2、rar 2 | 建父目录 |
| `copy_cancellable` | zip 3、tar 3、sevenz 2 | **RAR 不用**（见第三节问题 B） |
| `collect_sources` | zip 2、tar 2、sevenz 2 | 创建压缩包时遍历用户选区 |
| `SourceItem` | sevenz 5 | 创建时的成员清单 |
| `filetime_to_local_parts` | tar 2、sevenz 2 | 写归档时间 |
| `zip_datetime` | zip 2 | 写 ZIP 时间 |
| `sha256_file` | rar 4 | 校验 RAR DLL 与分卷 |
| `wide_path` | rar 3 | Win32 API 长路径 |
| `utf16_to_string` | rar 4 | RAR 头里的 UTF-16 文件名 |
| `to_wide` | download 1 | WinHTTP 宽字符 |
| `decode_ansi` | preview 2 | 预览非 UTF-8 文本 |
| `is_probably_text` | preview 2 | 未知扩展名先嗅 8 KiB |
| `io_err` | mod.rs 6 | 错误转字符串 |
| `MAX_TOTAL_UNPACKED` | 仅 util 自身 | 见问题 A |
| `MAX_PREVIEW_BYTES` | preview 3 | 媒体预览上限 16 MiB |
| `metadata_filetime` | 仅 util 自身 | 被 `zip_datetime` 用 |
| `normalized_name` | 仅 util 自身 | 被 `safe_relative` 用 |
| `unique_path` | 仅 util 自身 | 被 `resolve_dest` 用 |

**结论：删不得。** 除去三个内部辅助，每个函数都至少有两条真实调用路径。

---

## 三、深挖出来的四个真问题

按严重度排序。前三个不是这次改动引入的，是一直都在。

### 问题 A（最严重，已实测坐实）：`32 GiB 上限` 是每个成员各 32 GiB，不是整个解压任务 32 GiB

`copy_cancellable` 的计数器在函数内部从零开始：

```rust
pub fn copy_cancellable<R: Read + ?Sized, W: Write>(
    reader: &mut R, writer: &mut W, cancel: &AtomicBool, mut on_bytes: impl FnMut(u64),
) -> Result<u64> {
    let mut total = 0u64;          // ← 每次调用重新开始
    loop {
        ...
        total += n as u64;
        if total > MAX_TOTAL_UNPACKED {
            bail!("解压数据超过 32 GiB 上限，已停止");
        }
```

而调用方是**按成员循环**调的（`zip_impl.rs:197`、`zip_impl.rs:333`、`tar_impl.rs:213`、`tar_impl.rs:268`、`sevenz_impl.rs:355`）。所以实际语义是「**单个成员**不能超过 32 GiB」。

变更记录 1.11.0 写的是「单次解压上限 32 GiB」——这句话把一个逐成员的判断说成了全局判断。

真实风险：一个含 1000 个 31 GiB 成员的压缩包（压缩后可能只有几百 MB，全部由零字节构成、压缩率极高），现有代码会一个一个往下写，理论上写出 31 TB 才停。硬盘在几百 GB 时会写满，然后在写满时报一个 `无法写入` 的 IO 错误——用户看到的是「解压到一半报错、C 盘红了」，而不是「检测到可疑压缩包，已停止」。

跨领域对照：`tar`、`unzip` 的同类实现都用**跨成员累计**计数（例如 `bsdtar` 的 `--max-bytes`、`libarchive` 除 `bytes_in_last_entry` 之外还跟一个 `total_bytes`）。逐成员计数在这个场景下等于没有。

**已实测坐实（不是读代码推断）**：`util.rs` 末尾加了 `cap_is_cumulative`（`#[ignore]`，因为要跑 34 GiB 内存拷贝），用 `io::repeat(0)` + `io::sink()` 调真实的 `copy_cancellable`，不碰磁盘。第一次调用 17 GiB 通过；第二次再 17 GiB（合计 34 GiB，超过 32 GiB）**照样通过**：

```
thread 'archive::util::tests::cap_is_cumulative' panicked at src\archive\util.rs:623:9:
合计 34 GiB 已超过 32 GiB 上限，第二个成员应当被拦住；
这里通过说明上限是逐成员算的，整包总量没有任何封顶
test result: FAILED. 0 passed; 1 failed; 0 ignored
```

手动验证命令：`cargo test --release cap_is_cumulative -- --ignored`。
常规门禁不受影响：`cargo test --release` → `19 passed; 1 ignored`，零警告。

这不是理论问题：`zip` crate 的 `entry.size()` 在读之前就告诉了真实解压后大小，**完全可以在进入循环前先把整个包的总量算出来**，一旦超过阈值直接拒绝，一个字节都不写。

### 问题 B：RAR 路径完全绕过这个上限，也不经过 `copy_cancellable`

`rar.rs` 里没有任何 `copy_cancellable` 调用（上一轮 grep 已确认）。解压由 `UnRAR64.dll` 自己写盘，Rust 侧只记账：

```rust
report.bytes += size;      // rar.rs:524
progress.add_bytes(size);
```

`size` 来自 DLL 报告的头信息。所以 RAR 炸弹（超高压缩比 + 声明大尺寸）在这条路径上**没有任何字节级上限，也没有取消能力**——取消检查只在成员之间（`rar.rs:421`），一个大成员写到一半按取消要等它写完。

同一条结论的另一面：`MAX_TOTAL_UNPACKED` 这个名字起得比实现大。它保护的是 zip / tar / sevenz / gz / bz2 / xz，不保护 rar。

### 问题 C（已实测坐实）：`Overwrite::Overwrite` 会顺着已存在的符号链接写到目录外

```rust
pub fn resolve_dest(path: PathBuf, is_dir: bool, policy: Overwrite) -> Result<Option<PathBuf>> {
    if is_dir { return Ok(Some(path)); }
    if !path.exists() { return Ok(Some(path)); }
    match policy {
        Overwrite::Overwrite => Ok(Some(path)),   // ← 不检查 path 是不是链接
        ...
```

`safe_join` 只校验**成员名**是安全的相对路径，不校验**落点**是不是重解析点。如果目标目录里事先存在一个名为 `report.pdf` 的符号链接指向 `C:\Windows\System32\drivers\etc\hosts`，用户选「覆盖」解压时，`File::create` 会跟随链接写到链接目标。

`Overwrite::Rename` 分支没这个问题（`unique_path` 找的是一定不存在的名字）。`Overwrite::Skip` 也不会写。

威胁模型要说清楚：这需要**攻击者事先在用户的解压目录里放好符号链接**，也就是已经有本地写权限。它不是远程攻击面。但它确实是一条「解压不应该写到目标目录之外」的边界漏洞，和 `safe_relative` 那一大套校验想达成的目标矛盾——名字校验得很严，落点却没校验。

修法不复杂：`Create` 时用 `FILE_FLAG_OPEN_REPARSE_POINT`，或者写之前先 `symlink_metadata` 看一眼目标是不是 reparse point。后者几行就够。

**已实测坐实**：`util.rs` 加了 `overwrite_does_not_follow_existing_symlink`，真建一个符号链接（`symlink_file(&outside, &inner.join("a.txt"))`），走真实的 `resolve_dest(link, false, Overwrite::Overwrite)`：

```
thread 'archive::util::tests::overwrite_does_not_follow_existing_symlink' panicked at src\archive\util.rs:664:9:
覆盖策略把符号链接当成了普通文件；File::create 会跟随它写到目标目录之外
test result: FAILED. 0 passed; 1 failed
```

本机（Windows 11，非管理员）创建符号链接**成功**了，所以这不是「理论上可能」——`resolve_dest` 返回的就是那个链接本身，后续 `File::create` 必然跟随。

这条用例暂时标了 `#[ignore]`，理由写在注释里：它的作用是**把缺陷固定成可复现的证据**，而不是让门禁一直红着。修好后应当去掉 ignore。手动验证：`cargo test --release overwrite_does_not_follow -- --ignored`。

### 问题 D：`collect_sources` 里同一件事写了三遍，其中一遍是死代码

```rust
let walker = WalkDir::new(source)
    .follow_links(false)
    .into_iter()
    .filter_entry(|e| {
        let p = e.path();
        if Some(p) == skip { return false; }        // 第一遍
        if let Some(skip) = skip {
            if p == skip { return false; }          // 第二遍，与第一遍完全等价
        }
        true
    });
for entry in walker {
    ...
    if Some(path) == skip { continue; }             // 第三遍
```

第二遍是纯死代码（`Some(p) == skip` 与 `skip.map_or(false, |s| p == s)` 同一个判断）。第三遍在 `filter_entry` 已经过滤之后仍然保留，属于重复但无害。

无害不等于无成本：这三段会让下一个读它的人以为 `skip` 和 `filter_entry` 有某种微妙差别，实际上没有。

---

## 四、三个次要问题

### 次要 1：`to_wide` 与 `wide_path` 是同一个函数

```rust
pub fn to_wide(s: &str) -> Vec<u16> {
    std::ffi::OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
}
pub fn wide_path(path: &Path) -> Vec<u16> {
    path.as_os_str().encode_wide().chain(std::iter::once(0)).collect()
}
```

唯一差别是入参类型。`to_wide` 只有一个调用者（`download.rs`，通过 `use super::util::to_wide as wide;` 这个别名）。`&str` 转 `&Path` 零成本，两个可以合成一个。

这一点上一轮已经加过一条测试（`to_wide_appends_nul` 断言 `to_wide("ab") == wide_path(Path::new("ab"))`），就是为了防这两条 Win32 路径将来漂移。测试在，说明这个重复是被意识到的；但测试防的是漂移，不是消除重复。

### 次要 2：模块内可见性写法不统一

`main.rs:15` 是 `mod archive;`（非 pub），所以 `archive` 对外部 crate 不可见。这意味着 `util.rs` 里那 23 个 `pub` **实际等效于 `pub(crate)`**。

而后加的 `ARCHIVE_SUFFIXES` / `kind_of_suffix` / `archive_ext_names` 在 `mod.rs` 里写的是 `pub(crate)`。

同一个模块里两种写法表达同一件事。读代码的人会以为 `pub` 那批是给外部用的。

### 次要 3：`unique_path` 到 10000 次后退回一个可能已存在的名字

```rust
for i in 2..10000 { ... if !candidate.exists() { return candidate; } }
parent.join(format!("{stem} (copy)"))     // ← 没查重
```

一万个同名文件同时存在才会触发，现实中少见；但触发时是**静默覆盖**，而整个 `Rename` 分支的存在意义就是「不覆盖」。

同一个位置还有个更常见的竞态：`exists()` 与随后 `File::create()` 之间的窗口。多线程解压同一个包（`zip_impl` 有并行路径）时，两个线程可能拿到同一个 `unique_path` 结果。实际影响是两个成员互相覆盖——但这两个成员本来就在同一个包里、通常不同名，概率很低。

---

## 五、历史包袱判断

上一轮删了 4 个（`file_size` / `is_archive_ext` / `sha256_hex` / `read_limited`），接上了 2 个（`utf16_to_string` / `to_wide`）。现在剩下的 23 项**没有一项是死代码**：

- `metadata_filetime` / `normalized_name` / `unique_path` 只被 util 内部调用，但都在活跃路径上。可以私有化（`pub` 改 `fn`），不必删。
- `MAX_TOTAL_UNPACKED` 只被 util 自身引用，是问题 A 的核心，动它要连着改所有调用方。

**真正该问的不是「哪个能删」，是「这个文件该不该拆」。**

按变更频率与风险，自然的切法是三份：

1. `path.rs` —— `normalized_name` / `safe_relative` / `safe_join` / `ensure_parent` / `Overwrite` / `resolve_dest` / `unique_path`。这一组是安全边界，改动必须配安全测试。
2. `progress.rs` —— `Progress` / `copy_cancellable`。这一组是总线。
3. `win.rs`（或 `encoding.rs`）—— `decode_ansi` / `utf16_to_string` / `to_wide` / `wide_path` / `filetime_to_local_parts` / `metadata_filetime` / `sha256_file`。这一组是平台适配。

剩下的 `collect_sources` / `SourceItem` / `zip_datetime` / `io_err` 是零散件，跟着创建路径走。

---

## 六、如果真要动，正确顺序

不是「先拆再修」。拆分会立刻让三个安全函数的调用点分散到新文件，而问题 A 和 C 都在这三个函数上——同时动两件事，出问题时分不清是拆分引入的还是修 bug 引入的。

1. **先修 A 和 C，不拆文件。** 两者都能在现有结构里改完，且都能用真包写回归测试（造一个含两个 20 GiB 零字节成员的 zip、造一个预置符号链接的目录）。
2. **再修 D 和次要 1、3。** 纯清理，测试不用变。
3. **最后才拆。** 拆的时候测试已经覆盖住安全边界，纯粹是文件搬运，`cargo test` 是唯一需要的验证。
4. 问题 B（RAR）不在这条线上——它需要 DLL 侧配合，而且本机没有 `.rar` 样本、没有 WinRAR/7z、`UnRAR64.dll` 也没下载，**做不了真机验证**。只能写代码 + 写注释标清「未验证」。

---

## 七、一句话总结

这个文件是压缩包模块的地基，删不得、也没有真死代码了。但它有**一条名不副实的体积上限（A）、一条完全绕过该上限的路径（B）、一条落点未校验的覆盖分支（C）**。这三条都属于「安全边界」，都不在这次的扩展名/预览改动范围里，也都不该和拆分混在一个版本里做。

---

## 八、这份报告的证据等级

区分一下哪些结论是跑出来的、哪些只是想出来的 —— 上一轮已经吃过「测试绿了但文件根本没改过」的亏，所以这里把话说清楚。

| 结论 | 等级 | 依据 |
|---|---|---|
| A 上限是逐成员的 | **实测坐实** | `cap_is_cumulative` 加进 `util.rs`，两个 17 GiB 成员合计 34 GiB 仍然通过，`test result: FAILED` |
| C 覆盖会跟随符号链接 | **实测坐实** | `overwrite_does_not_follow_existing_symlink`，本机成功建链接后 `resolve_dest` 原样返回该链接 |
| B RAR 绕过上限与取消 | 代码核实 | 全文件 grep 无 `copy_cancellable`；`rar.rs:524` 只记账不校验；取消检查在成员之间（`rar.rs:421`） |
| D `collect_sources` 三处重复 | 代码核实 | 逐行读了 `filter_entry` 与循环体 |
| 次要 1/2/3 | 代码核实 | 同上 |
| 「没有真死代码了」 | 代码核实 | 每个导出项都 grep 出了活调用者，见第二节表格 |

两条实测用例都标了 `#[ignore]`，因为它们当前**必然失败**（缺陷还在）。作用是把缺陷固定成可复现的证据，而不是让门禁一直红。修掉 A 和 C 之后，应当去掉这两个 `ignore`。

常规门禁不受影响：`cargo test --release` → `19 passed; 0 failed; 2 ignored`，零警告。
