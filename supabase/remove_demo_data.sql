-- Removes every demo group (and, through cascades, its members, preferences,
-- listings, extractions and comparison runs). Real groups are untouched.
delete from groups where is_demo = true;
