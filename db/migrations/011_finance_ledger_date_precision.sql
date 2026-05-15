UPDATE finance_ledger_entries
SET
  occurred_at_precision = CASE
    WHEN occurred_at IS NULL OR trim(occurred_at) = '' THEN 'unknown'
    WHEN length(trim(occurred_at)) = 10
      AND trim(occurred_at) LIKE '____-__-__' THEN 'day'
    WHEN length(trim(occurred_at)) > 10
      AND substr(trim(occurred_at), 5, 1) = '-'
      AND substr(trim(occurred_at), 8, 1) = '-'
      AND substr(trim(occurred_at), 11, 1) IN ('T', 't', ' ') THEN 'datetime'
    WHEN length(trim(occurred_at)) = 7
      AND trim(occurred_at) LIKE '____-__' THEN 'month'
    WHEN length(trim(occurred_at)) = 4
      AND trim(occurred_at) LIKE '____' THEN 'year'
    ELSE 'unknown'
  END,
  posted_at_precision = CASE
    WHEN posted_at IS NULL OR trim(posted_at) = '' THEN 'unknown'
    WHEN length(trim(posted_at)) = 10
      AND trim(posted_at) LIKE '____-__-__' THEN 'day'
    WHEN length(trim(posted_at)) > 10
      AND substr(trim(posted_at), 5, 1) = '-'
      AND substr(trim(posted_at), 8, 1) = '-'
      AND substr(trim(posted_at), 11, 1) IN ('T', 't', ' ') THEN 'datetime'
    WHEN length(trim(posted_at)) = 7
      AND trim(posted_at) LIKE '____-__' THEN 'month'
    WHEN length(trim(posted_at)) = 4
      AND trim(posted_at) LIKE '____' THEN 'year'
    ELSE 'unknown'
  END,
  cleared_at_precision = CASE
    WHEN cleared_at IS NULL OR trim(cleared_at) = '' THEN 'unknown'
    WHEN length(trim(cleared_at)) = 10
      AND trim(cleared_at) LIKE '____-__-__' THEN 'day'
    WHEN length(trim(cleared_at)) > 10
      AND substr(trim(cleared_at), 5, 1) = '-'
      AND substr(trim(cleared_at), 8, 1) = '-'
      AND substr(trim(cleared_at), 11, 1) IN ('T', 't', ' ') THEN 'datetime'
    WHEN length(trim(cleared_at)) = 7
      AND trim(cleared_at) LIKE '____-__' THEN 'month'
    WHEN length(trim(cleared_at)) = 4
      AND trim(cleared_at) LIKE '____' THEN 'year'
    ELSE 'unknown'
  END;
