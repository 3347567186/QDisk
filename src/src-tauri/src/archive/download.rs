use std::ffi::c_void;
use std::fs::{self, File};
use std::io::Write;
use std::os::windows::process::CommandExt;
use std::path::Path;
use std::process::Command;
use std::ptr;

use anyhow::{bail, Context, Result};
use windows_sys::Win32::Networking::WinHttp::{
    WinHttpCloseHandle, WinHttpConnect, WinHttpOpen, WinHttpOpenRequest, WinHttpQueryDataAvailable,
    WinHttpQueryHeaders, WinHttpReadData, WinHttpReceiveResponse, WinHttpSendRequest,
    WINHTTP_ACCESS_TYPE_DEFAULT_PROXY, WINHTTP_FLAG_SECURE, WINHTTP_QUERY_FLAG_NUMBER,
    WINHTTP_QUERY_STATUS_CODE,
};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub fn download(url: &str, dest: &Path) -> Result<()> {
    let rest = url
        .strip_prefix("https://")
        .with_context(|| format!("只支持 https 下载: {url}"))?;
    let (host, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, "/"),
    };
    if host.is_empty() {
        bail!("下载地址缺少主机名");
    }
    let host_w = wide(host);
    let path_w = wide(path);
    let agent = wide("TidyAssistant/1.0");

    unsafe {
        let session = WinHttpOpen(
            agent.as_ptr(),
            WINHTTP_ACCESS_TYPE_DEFAULT_PROXY,
            ptr::null(),
            ptr::null(),
            0,
        );
        if session.is_null() {
            bail!("WinHTTP 初始化失败");
        }
        let result = (|| -> Result<()> {
            let connect = WinHttpConnect(session, host_w.as_ptr(), 443, 0);
            if connect.is_null() {
                bail!("无法连接下载服务器");
            }
            let method_w = wide("GET");
            let request = WinHttpOpenRequest(
                connect,
                method_w.as_ptr(),
                path_w.as_ptr(),
                ptr::null(),
                ptr::null(),
                ptr::null(),
                WINHTTP_FLAG_SECURE,
            );
            if request.is_null() {
                WinHttpCloseHandle(connect);
                bail!("无法创建下载请求");
            }
            let out = (|| -> Result<()> {
                if WinHttpSendRequest(request, ptr::null(), 0, ptr::null_mut(), 0, 0, 0) == 0 {
                    bail!("下载请求发送失败");
                }
                if WinHttpReceiveResponse(request, ptr::null_mut()) == 0 {
                    bail!("下载服务器无响应");
                }
                let mut status: u32 = 0;
                let mut len = std::mem::size_of::<u32>() as u32;
                WinHttpQueryHeaders(
                    request,
                    WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                    ptr::null(),
                    &mut status as *mut _ as *mut c_void,
                    &mut len,
                    ptr::null_mut(),
                );
                if status != 200 {
                    bail!("下载失败，HTTP 状态码 {status}");
                }
                let mut file = File::create(dest)
                    .with_context(|| format!("无法写入 {}", dest.display()))?;
                let mut buf = vec![0u8; 64 * 1024];
                loop {
                    let mut available: u32 = 0;
                    if WinHttpQueryDataAvailable(request, &mut available) == 0 {
                        bail!("读取下载数据失败");
                    }
                    if available == 0 {
                        break;
                    }
                    let mut got: u32 = 0;
                    let want = available.min(buf.len() as u32);
                    if WinHttpReadData(
                        request,
                        buf.as_mut_ptr() as *mut c_void,
                        want,
                        &mut got,
                    ) == 0
                    {
                        bail!("读取下载数据失败");
                    }
                    if got == 0 {
                        break;
                    }
                    file.write_all(&buf[..got as usize])?;
                }
                file.sync_all()?;
                Ok(())
            })();
            WinHttpCloseHandle(request);
            WinHttpCloseHandle(connect);
            out
        })();
        WinHttpCloseHandle(session);
        result
    }
}

pub fn extract_sfx_member(sfx: &Path, member: &str, out_dir: &Path) -> Result<std::path::PathBuf> {
    fs::create_dir_all(out_dir)?;
    let output = Command::new("tar.exe")
        .arg("-xf")
        .arg(sfx)
        .arg("-C")
        .arg(out_dir)
        .arg(member)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .context("无法启动系统 tar.exe；Windows 10 1803 及以上应自带")?;
    if !output.status.success() {
        bail!(
            "tar.exe 解包失败: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    let file = out_dir.join(member.replace('/', "\\"));
    if !file.exists() {
        bail!("tar.exe 未生成 {member}");
    }
    Ok(file)
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}
