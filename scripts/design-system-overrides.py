"""Usage: python3 scripts/design-system-overrides.py app/public > /tmp/overrides.css, then replace the generated block
at the end of app/public/app.css (the last part of its design-system section) with the output.

Generate design-system overrides: raise sub-11px text to 11px and turn all-caps labels into sentence case,
re-declaring each selector inside the same @media context so later-loaded rules win without changing other breakpoints."""
import re, sys
root = sys.argv[1]
def strip_comments(c): return re.sub(r'/\*.*?\*/', '', c.lstrip('\ufeff'), flags=re.S)
def walk(css, media=None):
    i, n = 0, len(css)
    while i < n:
        j = css.find('{', i)
        if j < 0: return
        head = css[i:j].strip()
        depth, k = 1, j + 1
        while k < n and depth:
            if css[k] == '{': depth += 1
            elif css[k] == '}': depth -= 1
            k += 1
        body = css[j + 1:k - 1]
        if head.startswith('@media'): yield from walk(body, head)
        elif head.startswith('@'): pass
        elif head: yield media, head, body
        i = k
# Everything in app.css above the design-system section; the generated rules belong at the end of that section.
css = open(f'{root}/app.css', encoding='utf-8').read()
sources = {'app.css (before the design system)': css[:css.index('/* ==== design-system.css ==== */')]}
out = []
for name, css in sources.items():
    groups = {}
    for media, sel, body in walk(strip_comments(css)):
        decl = []
        m = re.search(r'font-size:\s*(\d+(?:\.\d+)?)px\s*(!important)?', body) or re.search(r'(?<![-\w])font:[^;]*?\b(\d+(?:\.\d+)?)px[^;]*?(!important)?(?:;|$)', body)
        if m and float(m.group(1)) < 11: decl.append('font-size:11px' + ('!important' if m.group(2) else ''))
        if 'uppercase' in body: decl += ['text-transform:none', 'letter-spacing:0']
        if decl: groups.setdefault(media, []).append(f'{sel}{{{";".join(decl)}}}')
    if groups:
        out.append(f'/* from {name} */')
        for media, rules in groups.items():
            out.append('\n'.join(rules) if media is None else f'{media}{{\n' + '\n'.join(rules) + '\n}')
print('\n'.join(out))
