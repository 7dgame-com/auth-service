-- Apply only to the approved development Identity database or its rehearsal copy.
-- Give the adapter account SELECT/INSERT/UPDATE on this table only. No DELETE or account-table grants.
CREATE TABLE IF NOT EXISTS auth_development_wechat_scenes (
  scene_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  provider_app_id VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  issued_at DATETIME(3) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  openid_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  delivered_at DATETIME(3) NULL,
  PRIMARY KEY (scene_hash),
  KEY development_profile (provider_app_id, openid_hash, expires_at)
) ENGINE=InnoDB;
