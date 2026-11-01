// Transparent technical overlap only. This is not a hiring probability or an
// eligibility check, and it never infers a skill the profile does not supply.
const aliases = {
  'electrical engineering': ['electrical engineer', 'electrical engineering'],
  'controls engineering': ['control engineer', 'controls engineer', 'control engineering', 'controls engineering'],
  'validation engineer': ['validation engineer', 'validation engineering'],
  'hardware test': ['hardware test', 'hardware testing'],
  'energy harvesting': ['energy harvesting', 'energy-harvesting'],
  'test validation': ['test validation', 'test and validation', 'test & validation', 'test/validation']
};
export function keywordMatches(value, keywords) {
  const input = String(value || '').normalize('NFKC');
  return keywords.filter(word => {
    if (/[^\x00-\x7f]/.test(word)) return input.toLocaleLowerCase().includes(word.toLocaleLowerCase());
    return (aliases[word.toLowerCase()] || [word]).some(term => {
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g,'\\$&').replace(/ /g,'[\\s-]+');
      const plural = /[a-z]$/i.test(term) && !/s$/i.test(term) ? 's?' : '';
      return new RegExp(`(?<![a-z0-9])${escaped}${plural}(?![a-z0-9])`,'i').test(input);
    });
  });
}

export function validateProfile(profile) {
  if (profile === null || profile === undefined) return null;
  const validText = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
  const validKeywords = values => Array.isArray(values) && values.length > 0 && values.length <= 50 && values.every(v=>validText(v,80));
  if (!profile || typeof profile !== 'object' || Array.isArray(profile) || !Array.isArray(profile.categories) || profile.categories.length > 20 || profile.categories.some(c => !c || !validText(c.id,60) || !validText(c.label,100) || !validText(c.evidence,300) || !validKeywords(c.keywords) || !Number.isInteger(c.weight) || c.weight < 1 || c.weight > 5) || new Set(profile.categories.map(c=>c.id)).size !== profile.categories.length) throw new Error('Invalid config matchProfile categories');
  if (profile.exploratory !== undefined && (!Array.isArray(profile.exploratory) || profile.exploratory.length > 10 || profile.exploratory.some(c=>!c || !validText(c.label,100) || !validText(c.missingEvidence,300) || !validKeywords(c.keywords)))) throw new Error('Invalid config matchProfile exploratory categories');
  return profile;
}

export function profileMatch(title, description, profile) {
  if (!profile) return null;
  const matched = [];
  let score = 0;
  for (const category of profile.categories) {
    const titleTerms = keywordMatches(title,category.keywords);
    const descriptionTerms = keywordMatches(description,category.keywords);
    const terms = [...new Set([...titleTerms,...descriptionTerms])];
    if (!terms.length) continue;
    // One contribution per category prevents long keyword lists from inflating scores.
    const points = category.weight * (titleTerms.length ? 3 : 1);
    score += points;
    matched.push({ category:category.label, evidence:category.evidence, terms, where:titleTerms.length ? 'title' : 'description only', points });
  }
  const exploratory = (profile.exploratory || []).flatMap(category => {
    const terms = keywordMatches(`${title} ${description}`,category.keywords);
    return terms.length ? [{ label:category.label, terms, missingEvidence:category.missingEvidence }] : [];
  });
  return { score, label:'Technical keyword overlap — review role requirements; not a probability', matched, exploratory };
}

export function renderProfileMatch(match, funding = false) {
  if (!match) return '';
  const evidence = match.matched.slice(0,3).map(m=>`${m.category}: ${m.evidence} [${m.terms.slice(0,4).join(', ')}; ${m.where}]`);
  const exploratory = match.exploratory.slice(0,2).map(m=>`${m.label}: ${m.missingEvidence}`);
  return `\n${funding ? 'Company technical priority' : 'Technical overlap score'}: ${match.score} points (keyword rule; no probability)${evidence.length ? `\nResume evidence: ${evidence.join(' | ')}` : '\nNo demonstrated technical category overlap found.'}${exploratory.length ? `\nExploratory / missing evidence: ${exploratory.join(' | ')}` : ''}${funding ? '\nCompany-level overlap does not verify an available role.' : ''}`;
}
