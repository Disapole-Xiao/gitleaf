param(
    [Parameter(Mandatory = $true)][string]$BinDir,
    [switch]$Remove,
    # Tests use an isolated HKCU subkey; installation always uses Environment.
    [string]$RegistrySubKey = 'Environment'
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($RegistrySubKey)
try {
    # Read the unexpanded value and retain REG_EXPAND_SZ. setx and a copy of
    # process PATH can truncate data or persist expanded/system PATH entries.
    $raw = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString
    if ($key.GetValueNames() -contains 'Path') { $kind = $key.GetValueKind('Path') }
    if ($kind -ne [Microsoft.Win32.RegistryValueKind]::String -and $kind -ne [Microsoft.Win32.RegistryValueKind]::ExpandString) {
        throw 'User PATH is not a string registry value; refusing to replace it.'
    }
    $target = $BinDir.TrimEnd('\', '/')
    $entries = @($raw -split ';')
    $matches = @($entries | Where-Object {
        [Environment]::ExpandEnvironmentVariables($_.Trim().Trim('"')).TrimEnd('\', '/') -ieq $target
    })
    $changed = $false
    if ($Remove -and $matches.Count -gt 0) {
        $value = (@($entries | Where-Object { $matches -notcontains $_ }) -join ';')
        $key.SetValue('Path', $value, $kind)
        $changed = $true
    } elseif (-not $Remove -and $matches.Count -eq 0) {
        $value = if ($raw) { "$BinDir;$raw" } else { $BinDir }
        $key.SetValue('Path', $value, $kind)
        $changed = $true
    }
} finally {
    $key.Dispose()
}
if ($changed -and $RegistrySubKey -eq 'Environment') {
    # Notify Explorer so subsequently launched terminal apps inherit the new
    # user PATH. Existing terminals/agents still need to be restarted.
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class GitLeafEnvironment {
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint msg,
        UIntPtr wParam, string lParam, uint flags, uint timeout, out UIntPtr result);
}
'@
    $result = [UIntPtr]::Zero
    [void][GitLeafEnvironment]::SendMessageTimeout([IntPtr]0xffff, 0x001a,
        [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result)
}
@{ changed = $changed } | ConvertTo-Json -Compress
