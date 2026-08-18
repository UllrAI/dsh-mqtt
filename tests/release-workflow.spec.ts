import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const workflow = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')

describe('release workflow', () => {
  it('is tag-driven and verifies the package before publishing', () => {
    expect(workflow).toContain("tags:\n      - 'v*.*.*'")
    expect(workflow).toContain('tag_version="${GITHUB_REF_NAME#v}"')
    expect(workflow).toContain("package_version=\"$(node -p \"require('./package.json').version\")\"")
    expect(workflow).toContain('pnpm install --frozen-lockfile')
    expect(workflow).toContain('run: pnpm check')
    expect(workflow).toContain('run: pnpm publish --no-git-checks')
    expect(workflow).toContain('NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}')
    expect(workflow).toContain('softprops/action-gh-release@v2')
  })

  it('does not enable prerelease publishing implicitly', () => {
    expect(workflow).toContain('if [[ "$tag_version" == *-* ]]')
    expect(workflow).toContain('prerelease: false')
  })
})
