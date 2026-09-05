// Runs before any test-file imports, so decorators and services that read env
// at import time see the test configuration.
process.env.APP_ENV = 'test';
// Auth rate limit raised so multi-suite runs do not trip the 10/min default.
process.env.THROTTLE_AUTH_LIMIT = '30';