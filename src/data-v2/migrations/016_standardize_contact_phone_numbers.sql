-- Standardize 10-digit phone numbers in campus_contacts to standard (XXX) XXX-XXXX format.
UPDATE rockygpt_v2.campus_contacts
SET phone = regexp_replace(phone, '^\(?([0-9]{3})\)?[-. ]*([0-9]{3})[-. ]*([0-9]{4})$', '(\1) \2-\3')
WHERE phone ~ '^\(?([0-9]{3})\)?[-. ]*([0-9]{3})[-. ]*([0-9]{4})$';
