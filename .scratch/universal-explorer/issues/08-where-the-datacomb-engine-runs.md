# Where the datacomb engine runs

Type: grilling
Status: open
Blocked by: 03, 04, 05

## Question

Where does the code that records and serves datacombs run, given the performance bar and wasm parity?
- host-side, served into the guest (virtiofs or vhost-user daemon)
- in-guest userspace (FUSE)
- in-guest kernel
- a hybrid

What runs in the browser's equivalent position?
