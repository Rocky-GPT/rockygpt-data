/** A food mention or a free RSVP does not establish complimentary food. */
export function publishedFoodSignal(text: string): {
  offersFreeFood?: boolean;
  foodCategory?: 'food' | 'snacks';
} {
  const serving = text.match(/(?:do you plan on serving food\??|serving food\??)\s*[:\-]?\s*(true|false|yes|no)\b/i);
  if (serving && /^(false|no)$/i.test(serving[1])) return { offersFreeFood: false };

  for (const sentence of text.split(/[.!?\n]+/)) {
    // Negated, conditional, and donation-related mentions are not an offer.
    if (/\b(?:no|not|without|if|unless|food insecurity|food drive|food pantry)\b/i.test(sentence)) continue;
    const offer = sentence.match(/\b(?:free|complimentary)\s+(food|snacks?|refreshments?|cookies?|donuts?|bagels?|pizza|bbq|barbecue|breakfast|brunch|lunch|dinner|meals?|ice\s*cream)\b/i);
    if (!offer) continue;
    return {
      offersFreeFood: true,
      foodCategory: /^(?:snacks?|refreshments?|cookies?|donuts?|bagels?)$/i.test(offer[1]) ? 'snacks' : 'food',
    };
  }
  return {};
}
