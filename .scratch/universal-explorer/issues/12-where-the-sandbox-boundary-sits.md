# Where the sandbox boundary sits

Type: grilling
Status: open
Blocked by: 03

## Question

What is the isolation boundary around a Hermes session?
- the VM itself, with Hermes on its `local` terminal backend inside it
- Hermes running outside, with the VM as its terminal backend
- something else

The choice decides whether Hermes's state is inside or outside the runtime.
