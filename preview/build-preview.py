#!/usr/bin/env python3
"""Rebuild the full-page preview from build/index.html.
BG=aurora → animated aurora hero. Anything else → original static hero."""
import re, os, pathlib

HERE = pathlib.Path(__file__).parent
BG = os.environ.get('BG', 'aurora')
html = (HERE / '../build/index.html').read_text()
colour = (HERE / '../build/logo-colour.svg').read_text().replace('class="lock"', 'class="lock logo"', 1)
reversed_ = (HERE / '../build/logo-reversed.svg').read_text().replace('class="lock"', 'class="lock lockup"', 1)

html = html.replace('<title>Brimwood Innovation — Coming soon</title>',
                    '<title>Preview — Brimwood Innovation</title>', 1)
old = '  <img class="logo" src="logo-colour.svg" alt="Brimwood Innovation">'
assert old in html
html = html.replace(old, '  ' + colour, 1)
old = '  <img class="lockup" src="logo-reversed.svg" alt="Brimwood Innovation logo">'
assert old in html
html = html.replace(old, '  ' + reversed_, 1)

if BG == 'aurora':
    engine = (HERE / 'aurora.js').read_text()
    html = html.replace('<div class="hero">', '<div class="hero" id="hero">', 1)
    html, n = re.subn(r'<svg class="dots".*?</svg>', '<canvas id="stars" aria-hidden="true"></canvas>',
                      html, count=1, flags=re.S)
    assert n == 1, 'dots svg not found'
    old_css = '  .hero .dots{position:absolute;inset:0;pointer-events:none;opacity:.14}'
    new_css = '''  #stars{position:absolute;inset:0;width:100%;height:100%;display:block}
  .hero>*:not(#stars){position:relative;z-index:2}
  header svg.logo{height:38px;width:auto;display:block}
  .hero svg.lockup{width:min(430px,80vw);height:auto;margin:0 auto 34px;display:block}'''
    assert old_css in html
    html = html.replace(old_css, new_css, 1)
    assert html.count('</body>') == 1
    html = html.replace('</body>', '  <script>\n' + engine + '\n  </script>\n</body>', 1)
    out = HERE / 'particles-preview-full.html'
else:
    out = HERE / 'original-preview.html'

out.write_text(html)
print('preview rebuilt (%s):' % BG, len(html), 'bytes ->', out)
