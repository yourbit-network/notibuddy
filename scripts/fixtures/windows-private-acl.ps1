param(
  [Parameter(Mandatory = $true)][string]$Root,
  [switch]$SelfTest
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
trap {
  [Console]::Error.WriteLine('ACL_PROBE_FAILED: ' + $_.FullyQualifiedErrorId)
  [Console]::Error.WriteLine('ACL_PROBE_LINE: ' + $_.InvocationInfo.ScriptLineNumber)
  exit 1
}
$currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$allowed = @{
  ($currentSid.Value) = 'current-user'
  'S-1-5-18' = 'system'
  'S-1-5-32-544' = 'administrators'
}

function Read-PrivateAcl([string]$ItemPath) {
  $item = Get-Item -LiteralPath $ItemPath -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse points are outside this ACL check' }
  $acl = Get-Acl -LiteralPath $ItemPath
  $descriptor = [System.Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(), 0)
  $valid = $null -ne $descriptor.DiscretionaryAcl -and $allowed.ContainsKey($descriptor.Owner.Value)
  $grants = @()
  if ($null -ne $descriptor.DiscretionaryAcl) {
    foreach ($ace in $descriptor.DiscretionaryAcl) {
      # Inherit-only grants do not apply to this object; each child is checked.
      if (($ace.AceFlags -band [System.Security.AccessControl.AceFlags]::InheritOnly) -ne 0) { continue }
      if ($ace -isnot [System.Security.AccessControl.QualifiedAce]) { $valid = $false; continue }
      if ($ace.AceQualifier -eq [System.Security.AccessControl.AceQualifier]::AccessDenied) { continue }
      if ($ace.AceQualifier -ne [System.Security.AccessControl.AceQualifier]::AccessAllowed) { $valid = $false; continue }
      $role = $allowed[$ace.SecurityIdentifier.Value]
      if (!$role) { $role = 'other-principal'; $valid = $false }
      $grants += @{ role = $role; mask = $ace.AccessMask; inherited = $ace.IsInherited }
    }
  }
  return @{ private = [bool]$valid; directory = [bool]$item.PSIsContainer; grants = @($grants) }
}

if ($SelfTest) {
  # All writes are confined to a new, disposable, synthetic control directory.
  $control = Join-Path $Root ('acl-control-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $control -ErrorAction Stop | Out-Null
  try {
    $acl = [System.Security.AccessControl.DirectorySecurity]::new()
    $acl.SetOwner($currentSid)
    $acl.SetAccessRuleProtection($true, $false)
    $inherit = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
    foreach ($sid in $allowed.Keys) {
      $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
        [System.Security.Principal.SecurityIdentifier]::new($sid),
        [System.Security.AccessControl.FileSystemRights]::FullControl, $inherit,
        [System.Security.AccessControl.PropagationFlags]::None,
        [System.Security.AccessControl.AccessControlType]::Allow)
      $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $control -AclObject $acl
    $file = Join-Path $control 'synthetic.txt'
    [IO.File]::WriteAllText($file, 'Public synthetic ACL control; no credentials')
    if (!(Read-PrivateAcl $control).private -or !(Read-PrivateAcl $file).private) { throw 'Private control was rejected' }
    $fileAcl = Get-Acl -LiteralPath $file
    $fileAcl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
      [System.Security.Principal.SecurityIdentifier]::new('S-1-1-0'),
      [System.Security.AccessControl.FileSystemRights]::Read,
      [System.Security.AccessControl.AccessControlType]::Allow))
    Set-Acl -LiteralPath $file -AclObject $fileAcl
    if ((Read-PrivateAcl $file).private) { throw 'Everyone-readable control was accepted' }
    @{ privateControlAccepted = $true; everyoneReadableControlRejected = $true } | ConvertTo-Json -Compress
  } finally { Remove-Item -LiteralPath $control -Recurse -Force }
  exit 0
}

$base = (Get-Item -LiteralPath $Root -Force).FullName.TrimEnd('\')
$records = [System.Collections.Generic.List[object]]::new()
function Visit([string]$ItemPath) {
  $result = Read-PrivateAcl $ItemPath
  $result.path = if ($ItemPath -eq $base) { '.' } else { $ItemPath.Substring($base.Length).TrimStart('\') }
  $records.Add($result)
  if ($result.directory) {
    foreach ($child in Get-ChildItem -LiteralPath $ItemPath -Force) { Visit $child.FullName }
  }
}
Visit $base
$invalid = @($records | Where-Object { !$_.private })
@{ private = ($invalid.Count -eq 0); objects = @($records.ToArray()) } | ConvertTo-Json -Depth 8 -Compress
if ($invalid.Count -gt 0) { exit 1 }
