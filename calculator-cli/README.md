# calculator-cli

A simple Python-based command-line calculator supporting basic arithmetic operations.

## Installation

1. Ensure you have Python 3.8+ installed.
2. Clone or copy this repository to your local machine.
3. Navigate into the `calculator-cli` directory.

```bash
cd workspace/calculator-cli
```

No additional dependencies are required; only the Python Standard Library is used.

## Usage

Run the CLI with one of the supported operations followed by two numbers.

```bash
python cli.py add 10 5
python cli.py subtract 10 5
python cli.py multiply 10 5
python cli.py divide 10 5
```

Each command prints the result to stdout. Errors, such as division by zero, are shown on stderr and cause the program to exit with code 1.

## Testing

Execute the unittest suite with:

```bash
python -m unittest discover -s . -p "test_*.py" -v
```

This runs all tests defined in the repository and reports pass/fail status.
