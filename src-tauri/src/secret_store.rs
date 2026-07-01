use tauri::AppHandle;

fn target(app: &AppHandle, name: &str) -> String {
    let id = app.config().identifier.clone();
    format!("{id}:{name}")
}

#[cfg(target_os = "windows")]
fn wide(s: &str) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    std::ffi::OsStr::new(s)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

#[cfg(target_os = "windows")]
pub fn set_secret(app: &AppHandle, name: &str, value: Option<&str>) -> Result<(), String> {
    use std::ptr::null_mut;
    use windows_sys::Win32::Security::Credentials::{
        CredDeleteW, CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC,
    };

    let target_name = target(app, name);
    let mut target_w = wide(&target_name);

    let Some(value) = value.filter(|v| !v.is_empty()) else {
        unsafe {
            CredDeleteW(target_w.as_ptr(), CRED_TYPE_GENERIC, 0);
        }
        return Ok(());
    };

    let mut blob = value.as_bytes().to_vec();
    let mut credential = CREDENTIALW {
        Flags: 0,
        Type: CRED_TYPE_GENERIC,
        TargetName: target_w.as_mut_ptr(),
        Comment: null_mut(),
        LastWritten: unsafe { std::mem::zeroed() },
        CredentialBlobSize: blob.len() as u32,
        CredentialBlob: blob.as_mut_ptr(),
        Persist: CRED_PERSIST_LOCAL_MACHINE,
        AttributeCount: 0,
        Attributes: null_mut(),
        TargetAlias: null_mut(),
        UserName: null_mut(),
    };

    let ok = unsafe { CredWriteW(&mut credential, 0) };
    if ok == 0 {
        return Err("Could not save secret to Windows Credential Manager".into());
    }
    Ok(())
}

#[cfg(target_os = "windows")]
pub fn get_secret(app: &AppHandle, name: &str) -> Option<String> {
    use std::ptr::null_mut;
    use windows_sys::Win32::Security::Credentials::{
        CredFree, CredReadW, CREDENTIALW, CRED_TYPE_GENERIC,
    };

    let target_name = target(app, name);
    let target_w = wide(&target_name);
    let mut ptr: *mut CREDENTIALW = null_mut();
    let ok = unsafe { CredReadW(target_w.as_ptr(), CRED_TYPE_GENERIC, 0, &mut ptr) };
    if ok == 0 || ptr.is_null() {
        return None;
    }
    let secret = unsafe {
        let cred = &*ptr;
        let bytes =
            std::slice::from_raw_parts(cred.CredentialBlob, cred.CredentialBlobSize as usize);
        let value = String::from_utf8(bytes.to_vec()).ok();
        CredFree(ptr.cast());
        value
    };
    secret
}

#[cfg(not(target_os = "windows"))]
pub fn set_secret(_app: &AppHandle, _name: &str, _value: Option<&str>) -> Result<(), String> {
    Err("Secure secret storage is not implemented on this platform".into())
}

#[cfg(not(target_os = "windows"))]
pub fn get_secret(_app: &AppHandle, _name: &str) -> Option<String> {
    None
}
