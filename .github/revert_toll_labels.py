from pathlib import Path

p = Path('index.html')
s = p.read_text(encoding='utf-8')

start = s.find("// Extrait un nom lisible de gare de péage depuis la réponse Vinci/Ulys.")
end_marker = "// Via l'API interne (non documentée) de Vinci-autoroutes : reproduit"
if start == -1:
    raise SystemExit('helper start not found')
end = s.find(end_marker, start)
if end == -1:
    raise SystemExit('helper end marker not found')
s = s[:start] + s[end:]

old_gate = "return { code, abscissa: isNaN(abscissa) ? null : abscissa, label: libelleGarePeageVinci(l, code) };"
new_gate = "return { code, abscissa: isNaN(abscissa) ? null : abscissa };"
if s.count(old_gate) != 1:
    raise SystemExit(f'Expected one labelled gate return, found {s.count(old_gate)}')
s = s.replace(old_gate, new_gate, 1)

start_details = s.find('    const cost = tarifs.reduce((somme, t) => somme + t.price, 0);')
if start_details == -1:
    raise SystemExit('details start not found')
end_details_marker = "    return { cost, details, source: 'vinci' };"
end_details = s.find(end_details_marker, start_details)
if end_details == -1:
    raise SystemExit('details end not found')
end_details += len(end_details_marker)
new_details = """    const cost = tarifs.reduce((somme, t) => somme + t.price, 0);
    // L'API tarifaire ne fournit pas ici de libellé public fiable pour chaque
    // section : on garde un numéro de tronçon plutôt que d'afficher les codes
    // internes des gares comme s'il s'agissait de noms.
    const details = tarifs.map((t, i) => ({ label: 'Tronçon ' + (i + 1), price: t.price }));
    return { cost, details, source: 'vinci' };"""
s = s[:start_details] + new_details + s[end_details:]

expected = """  const stations = stationsExAequo
    // On sélectionne toujours les 5 stations qui demandent le moins de détour…
    .sort((a, b) => a.distRoute - b.distRoute || a.kmSurTrajet - b.kmSurTrajet)
    .slice(0, 5)
    // …mais on les présente dans l'ordre où le conducteur les rencontre.
    .sort((a, b) => a.kmSurTrajet - b.kmSurTrajet);"""
if expected not in s:
    raise SystemExit('station route-order fix missing')

p.write_text(s, encoding='utf-8')
