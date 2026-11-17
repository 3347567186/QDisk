# 第三方组件与许可

整理助手的压缩/解压功能使用以下组件。除 RAR 组件外，均以 Rust crate 形式静态链接；
RAR 组件在首次使用 RAR 时下载，不随安装包分发。

## RAR 读取：UnRAR64.dll

- 来源：https://www.rarlab.com/rar/unrardll-710.exe
- 版本：UnRAR DLL 7.10（x64）
- 文件：`x64/UnRAR64.dll`，398,992 字节
- SHA-256：`D3F371AD0E7D2E7904756C8CC5DEBE0BF9037E4729A95D5E17D60223B725AA90`
- 用途：仅读取/解压 RAR、RAR5 归档。不得用于开发 RAR 压缩器。
- 分发方式：首次打开 RAR 时从 RARLAB 官方地址下载 816,080 字节的
  `unrardll-710.exe`，校验 SHA-256 后用系统 `tar.exe` 提取 DLL，再校验 DLL
  哈希；不执行该 SFX。

许可证原文：

```text
      The unrar.dll library is freeware. This means:

   1. All copyrights to RAR and the unrar.dll are exclusively
      owned by the author - Alexander Roshal.

   2. The unrar.dll library may be used in any software to handle
      RAR archives without limitations free of charge.

   3. THE RAR ARCHIVER AND THE UNRAR.DLL LIBRARY ARE DISTRIBUTED "AS IS".
      NO WARRANTY OF ANY KIND IS EXPRESSED OR IMPLIED.  YOU USE AT
      YOUR OWN RISK. THE AUTHOR WILL NOT BE LIABLE FOR DATA LOSS,
      DAMAGES, LOSS OF PROFITS OR ANY OTHER KIND OF LOSS WHILE USING
      OR MISUSING THIS SOFTWARE.

      Thank you for your interest in RAR and unrar.dll.


                                            Alexander L. Roshal
```

## Rust crates

| 组件 | 版本 | 许可证 | 用途 |
|---|---|---|---|
| zip | 9.6 | MIT | ZIP 读写、AES、Deflate/Bzip2/XZ |
| sevenz-rust2 | 0.25 | Apache-2.0 | 7z 读写、LZMA2、AES-256 |
| lzma-rust2 | 0.25 | Apache-2.0 | LZMA/LZMA2 编解码 |
| flate2 + zlib-rs | 1.1 / 0.6 | MIT / Zlib | Deflate 与 gzip |
| bzip2 | 0.6 | MIT / BSD | bzip2 编解码 |
| tar | 0.4 | MIT / Apache-2.0 | TAR 读写 |
| walkdir | 2.5 | MIT / Unlicense | 目录遍历 |
| anyhow | 1 | MIT / Apache-2.0 | 错误传递 |
| libloading | 0.8 | ISC | 动态加载 UnRAR64.dll |
| sha2 | 0.10 | MIT / Apache-2.0 | SHA-256 校验 |

各 crate 的完整许可证文本可在 https://crates.io 对应版本页面查看。

## 前端动效：React Bits「Thought Line」

- 来源：https://www.reactbits.dev/micro/thought-line （仓库 https://github.com/DavidHDev/react-bits）
- 许可证：**MIT + Commons Clause v1.0**（不是纯 MIT），Copyright (c) 2026 David Haz
- 落地方式：**原生重写**，未引入原版的 `motion` / `@hugeicons/*` 依赖
  - `src\web\js\ai\thoughtline.js`：按原版参数口径用原生 DOM 重写（呼吸、微光、落定、折叠）
  - `src\web\styles.css` 的「思路行（thoughtline.js）」段：等价 CSS，全部走本项目 token
  - 呼吸 / 微光 / 落定 / 计时器滑动 / 过程折叠的行为与原版一致，尺寸与配色改用 `--fs-*`、`--text-*` 等既有 token
- 使用边界（照抄许可证的 Commons Clause）：可以作为**应用的一部分**随产品分发、也可以商用；
  **不得**把组件本身（含移植版）单独或打包出售、再许可、再分发，也不得做成托管服务。
  本项目只是把它当成「整理助手 AI 对话里的一行动画」，不对外发布该组件。

许可证原文：

```text
MIT + Commons Clause License Condition v1.0

Copyright (c) 2026 David Haz

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, and distribute the Software as part of
an application, website, or product, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

## Commons Clause Restriction

You may use this Software, including for any commercial purpose, so long as you
do not sell, sublicense, or redistribute the components themselves-whether
alone, in a bundle, or as a ported version.

The same restriction covers the React Bits tools (Background Studio, Texture
Lab, Shape Magic, Center Stage, Sound Lab and any tools added later) and the
sounds in the sound library. You may not sell, sublicense, or redistribute the
tools or the sounds themselves, or offer the tools or a substantially similar
copy of them as a hosted service-whether alone, in a bundle, or as a ported
version.

What you make with the tools is yours to use. You can use exported code,
images, videos, and audio files in any personal or commercial application,
website, or product, including paid ones. You may not sell or redistribute the
exports on their own, either individually or as the product itself, such as a
sound, texture, background, or template pack.

## No Warranty

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

