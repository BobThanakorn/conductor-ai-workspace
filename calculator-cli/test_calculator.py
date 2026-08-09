"""Unit tests for the calculator operations."""

import unittest

from calculator import add, subtract, multiply, divide


class CalculatorTests(unittest.TestCase):
    def test_add_positive_numbers(self) -> None:
        self.assertEqual(add(4, 6), 10)

    def test_add_negative_numbers(self) -> None:
        self.assertEqual(add(-3, -5), -8)

    def test_subtract_positive_numbers(self) -> None:
        self.assertEqual(subtract(10, 4), 6)

    def test_subtract_result_negative(self) -> None:
        self.assertEqual(subtract(2, 5), -3)

    def test_multiply_positive_numbers(self) -> None:
        self.assertEqual(multiply(3, 7), 21)

    def test_multiply_by_zero(self) -> None:
        self.assertEqual(multiply(3, 0), 0)

    def test_divide_whole_numbers(self) -> None:
        self.assertEqual(divide(10, 2), 5)

    def test_divide_fraction(self) -> None:
        self.assertAlmostEqual(divide(2, 3), 2 / 3)

    def test_divide_by_zero_raises(self) -> None:
        with self.assertRaises(ValueError):
            divide(5, 0)

    def test_divide_negative(self) -> None:
        self.assertEqual(divide(-10, 2), -5)


if __name__ == "__main__":
    unittest.main()
