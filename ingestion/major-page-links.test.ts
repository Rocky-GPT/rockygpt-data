import assert from 'node:assert/strict';
import test from 'node:test';

import { linkedPageUrls } from './major-page-links';

test('only Ramapo pages collected nowhere else are followed, once each', () => {
  const pages = [
    { links: [
      { url: 'https://www.ramapo.edu/dmc/4plus1/#enroll' },
      { url: 'http://www.ramapo.edu/dmc/4plus1/' },
      { url: 'https://www.ramapo.edu/success-stories/?page_id=109' },
      { url: 'https://bioinformatics.ramapo.edu/employment/index.html' },
      { url: 'https://www.ramapo.edu/majors-minors/majors/data-science/' },
      { url: 'https://www.ramapo.edu/majors-minors/' },
      { url: 'https://catalog.ramapo.edu/programs/SN-BS-CMPS/' },
      { url: 'https://apply.ramapo.edu/register/inquiry' },
      { url: 'https://www.ramapo.edu/undergraduate/wp-content/uploads/sites/283/2020/06/Form.pdf' },
      { url: 'https://www.bls.gov/ooh/' },
      { url: 'mailto:sfrees@ramapo.edu' },
      { url: 'not a url' },
    ] },
    { links: [{ url: 'https://www.ramapo.edu/dmc/4plus1/' }] },
    {},
  ];
  assert.deepEqual(linkedPageUrls(pages), [
    'https://bioinformatics.ramapo.edu/employment/index.html',
    'https://www.ramapo.edu/dmc/4plus1/',
    'https://www.ramapo.edu/success-stories/?page_id=109',
  ]);
});
