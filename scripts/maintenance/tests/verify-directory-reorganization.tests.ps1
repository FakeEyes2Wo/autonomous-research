$ErrorActionPreference = 'Stop'

function Assert-Equal {
    param([object]$Actual, [object]$Expected, [string]$Message)
    if ($Actual -ne $Expected) {
        throw "$Message (actual: '$Actual'; expected: '$Expected')"
    }
}

$scriptPath = Join-Path $PSScriptRoot '..\verify-directory-reorganization.ps1'
$powershell = (Get-Command powershell.exe).Source
$tempRoot = Join-Path ([IO.Path]::GetTempPath()) "directory-reorganization-test-$([guid]::NewGuid().ToString('N'))"
$mappingPath = Join-Path $tempRoot 'mapping.json'
$beforePath = Join-Path $tempRoot 'before.json'

try {
    New-Item -ItemType Directory -Path (Join-Path $tempRoot 'src') -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $tempRoot 'src\README.md') -Value @'
[valid](../keep.md)
[pre-existing missing](missing.md)

```markdown
[example placeholder](does-not-exist.md)
```
'@ -Encoding utf8
    Set-Content -LiteralPath (Join-Path $tempRoot 'keep.md') -Value 'keep' -Encoding utf8
    @{ migrations = @(@{ source = 'src'; destination = 'archive' }) } |
        ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $mappingPath -Encoding utf8

    $beforeRaw = & $powershell -NoProfile -File $scriptPath -Root $tempRoot -MappingPath $mappingPath -Phase Before
    Assert-Equal $LASTEXITCODE 0 'before phase should pass'
    $before = $beforeRaw | ConvertFrom-Json
    Assert-Equal $before.summary.migrationCount 1 'before migration count'
    Assert-Equal $before.migrations[0].source.fileCount 1 'before file count'
    Assert-Equal $before.markdown.summary.missingCount 1 'fenced links should be ignored'
    $before | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $beforePath -Encoding utf8

    New-Item -ItemType Directory -Path (Join-Path $tempRoot 'archive') -Force | Out-Null
    Move-Item -LiteralPath (Join-Path $tempRoot 'src\README.md') -Destination (Join-Path $tempRoot 'archive\README.md')
    Remove-Item -LiteralPath (Join-Path $tempRoot 'src')

    $afterRaw = & $powershell -NoProfile -File $scriptPath -Root $tempRoot -MappingPath $mappingPath -Phase After -BaselinePath $beforePath
    Assert-Equal $LASTEXITCODE 0 'after phase should pass'
    $after = $afterRaw | ConvertFrom-Json
    Assert-Equal $after.migrations[0].destination.fileCount 1 'after file count'
    Assert-Equal $after.migrations[0].integrity.treeSha256MatchesBaseline $true 'tree hash should survive move'
    Assert-Equal $after.markdown.summary.preExistingBrokenCount 1 'pre-existing broken link classification'
    Assert-Equal $after.markdown.summary.newlyBrokenCount 0 'migration should add no broken links'
}
finally {
    if (Test-Path -LiteralPath $tempRoot) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force
    }
}

Write-Output 'verify-directory-reorganization tests passed'
