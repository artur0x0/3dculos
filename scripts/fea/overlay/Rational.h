// Replacement for fTetWild's GMP rational.
//
// The upstream header is MPL-2.0 and calls mpq_* from GMP, which is
// LGPL-3.0-or-later OR GPL-2.0-or-later. This build does not ship GMP.
// The same operations are implemented with libtommath (Unlicense).
//
// This Source Code Form is subject to the terms of the Mozilla Public License
// v. 2.0. If a copy of the MPL was not distributed with this file, You can
// obtain one at http://mozilla.org/MPL/2.0/.

#ifndef TRIWILD_RATIONAL_H
#define TRIWILD_RATIONAL_H

#include <tommath.h>

#include <cmath>
#include <cstdint>
#include <iostream>
#include <stdexcept>
#include <string>

namespace triwild {

inline void rat_check(mp_err err)
{
    if (err != MP_OKAY) {
        throw std::runtime_error(std::string("libtommath: ") + mp_error_to_string(err));
    }
}

class Rational
{
public:
    mp_int num;
    mp_int den;

    Rational()
    {
        init_empty();
        mp_set(&den, 1);
    }

    Rational(int value) : Rational()
    {
        set_int(value);
    }

    Rational(double value) : Rational()
    {
        set_double(value);
    }

    Rational(const Rational& other)
    {
        if (mp_init_copy(&num, &other.num) != MP_OKAY) {
            throw std::runtime_error("libtommath: copy numerator failed");
        }
        if (mp_init_copy(&den, &other.den) != MP_OKAY) {
            mp_clear(&num);
            throw std::runtime_error("libtommath: copy denominator failed");
        }
    }

    Rational(Rational&& other) noexcept : num(other.num), den(other.den)
    {
        blank(&other.num);
        blank(&other.den);
    }

    Rational& operator=(const Rational& other)
    {
        if (this != &other) {
            rat_check(mp_copy(&other.num, &num));
            rat_check(mp_copy(&other.den, &den));
        }
        return *this;
    }

    Rational& operator=(Rational&& other) noexcept
    {
        if (this != &other) {
            mp_clear(&num);
            mp_clear(&den);
            num = other.num;
            den = other.den;
            blank(&other.num);
            blank(&other.den);
        }
        return *this;
    }

    Rational& operator=(double value)
    {
        set_double(value);
        return *this;
    }

    ~Rational()
    {
        mp_clear(&num);
        mp_clear(&den);
    }

    friend Rational operator-(const Rational& x)
    {
        Rational out(x);
        rat_check(mp_neg(&out.num, &out.num));
        out.canonicalize();
        return out;
    }

    friend Rational operator+(const Rational& x, const Rational& y)
    {
        Rational out;
        mp_int a;
        mp_int b;
        rat_check(mp_init(&a));
        rat_check(mp_init(&b));
        try {
            rat_check(mp_mul(&x.num, &y.den, &a));
            rat_check(mp_mul(&y.num, &x.den, &b));
            rat_check(mp_add(&a, &b, &out.num));
            rat_check(mp_mul(&x.den, &y.den, &out.den));
        } catch (...) {
            mp_clear(&a);
            mp_clear(&b);
            throw;
        }
        mp_clear(&a);
        mp_clear(&b);
        out.canonicalize();
        return out;
    }

    friend Rational operator-(const Rational& x, const Rational& y)
    {
        Rational out;
        mp_int a;
        mp_int b;
        rat_check(mp_init(&a));
        rat_check(mp_init(&b));
        try {
            rat_check(mp_mul(&x.num, &y.den, &a));
            rat_check(mp_mul(&y.num, &x.den, &b));
            rat_check(mp_sub(&a, &b, &out.num));
            rat_check(mp_mul(&x.den, &y.den, &out.den));
        } catch (...) {
            mp_clear(&a);
            mp_clear(&b);
            throw;
        }
        mp_clear(&a);
        mp_clear(&b);
        out.canonicalize();
        return out;
    }

    friend Rational operator*(const Rational& x, const Rational& y)
    {
        Rational out;
        rat_check(mp_mul(&x.num, &y.num, &out.num));
        rat_check(mp_mul(&x.den, &y.den, &out.den));
        out.canonicalize();
        return out;
    }

    friend Rational operator/(const Rational& x, const Rational& y)
    {
        if (mp_iszero(&y.num) == MP_YES) {
            throw std::runtime_error("rational division by zero");
        }
        Rational out;
        rat_check(mp_mul(&x.num, &y.den, &out.num));
        rat_check(mp_mul(&x.den, &y.num, &out.den));
        out.canonicalize();
        return out;
    }

    friend Rational pow(const Rational& x, int exponent)
    {
        if (exponent == 0) {
            return Rational(1);
        }
        if (exponent < 0) {
            if (mp_iszero(&x.num) == MP_YES) {
                throw std::runtime_error("negative power of zero");
            }
            Rational inv;
            rat_check(mp_copy(&x.den, &inv.num));
            rat_check(mp_copy(&x.num, &inv.den));
            inv.canonicalize();
            return pow(inv, -exponent);
        }
        Rational result(1);
        Rational base(x);
        int exp = exponent;
        while (exp > 0) {
            if ((exp & 1) != 0) {
                result = result * base;
            }
            exp >>= 1;
            if (exp > 0) {
                base = base * base;
            }
        }
        return result;
    }

    friend bool operator==(const Rational& x, const Rational& y)
    {
        return mp_cmp(&x.num, &y.num) == MP_EQ && mp_cmp(&x.den, &y.den) == MP_EQ;
    }

    friend bool operator!=(const Rational& x, const Rational& y)
    {
        return !(x == y);
    }

    friend bool operator<(const Rational& x, const Rational& y)
    {
        mp_int left;
        mp_int right;
        rat_check(mp_init(&left));
        rat_check(mp_init(&right));
        mp_ord ord = MP_EQ;
        try {
            rat_check(mp_mul(&x.num, &y.den, &left));
            rat_check(mp_mul(&y.num, &x.den, &right));
            ord = mp_cmp(&left, &right);
        } catch (...) {
            mp_clear(&left);
            mp_clear(&right);
            throw;
        }
        mp_clear(&left);
        mp_clear(&right);
        return ord == MP_LT;
    }

    friend bool operator>(const Rational& x, const Rational& y)
    {
        return y < x;
    }

    friend bool operator<=(const Rational& x, const Rational& y)
    {
        return !(y < x);
    }

    friend bool operator>=(const Rational& x, const Rational& y)
    {
        return !(x < y);
    }

    double to_double() const
    {
        if (mp_iszero(&num) == MP_YES) {
            return 0.0;
        }
        const int n_bits = mp_count_bits(&num);
        const int d_bits = mp_count_bits(&den);
        const int shift = std::max(n_bits, d_bits) - 53;
        if (shift <= 0) {
            return mp_get_double(&num) / mp_get_double(&den);
        }
        mp_int n;
        mp_int d;
        rat_check(mp_init(&n));
        rat_check(mp_init(&d));
        double value = 0.0;
        try {
            rat_check(mp_div_2d(&num, shift, &n, nullptr));
            rat_check(mp_div_2d(&den, shift, &d, nullptr));
            if (mp_iszero(&d) == MP_YES) {
                mp_set(&d, 1);
            }
            value = mp_get_double(&n) / mp_get_double(&d);
        } catch (...) {
            mp_clear(&n);
            mp_clear(&d);
            throw;
        }
        mp_clear(&n);
        mp_clear(&d);
        return value;
    }

    friend std::ostream& operator<<(std::ostream& os, const Rational& value)
    {
        os << value.to_double();
        return os;
    }

private:
    static void blank(mp_int* value)
    {
        value->dp = nullptr;
        value->used = 0;
        value->alloc = 0;
        value->sign = MP_ZPOS;
    }

    void init_empty()
    {
        if (mp_init(&num) != MP_OKAY) {
            throw std::runtime_error("libtommath: init numerator failed");
        }
        if (mp_init(&den) != MP_OKAY) {
            mp_clear(&num);
            throw std::runtime_error("libtommath: init denominator failed");
        }
    }

    void set_int(int value)
    {
        mp_set_i64(&num, static_cast<int64_t>(value));
        mp_set(&den, 1);
    }

    void set_double(double value)
    {
        mp_set(&num, 0);
        mp_set(&den, 1);
        if (value == 0.0) {
            return;
        }
        if (!std::isfinite(value)) {
            throw std::invalid_argument("non-finite coordinate cannot become an exact rational");
        }
        const bool negative = value < 0.0;
        value = std::fabs(value);
        int exponent = 0;
        const double fraction = std::frexp(value, &exponent);
        const auto scale = static_cast<double>(1ULL << 53);
        auto mantissa = static_cast<uint64_t>(std::llround(fraction * scale));
        if (mantissa == 0) {
            return;
        }
        mp_set_u64(&num, mantissa);
        const int shift = exponent - 53;
        if (shift > 0) {
            rat_check(mp_mul_2d(&num, shift, &num));
        } else if (shift < 0) {
            rat_check(mp_mul_2d(&den, -shift, &den));
        }
        if (negative) {
            rat_check(mp_neg(&num, &num));
        }
        canonicalize();
    }

    void canonicalize()
    {
        if (mp_iszero(&den) == MP_YES) {
            throw std::runtime_error("rational denominator is zero");
        }
        if (mp_isneg(&den) == MP_YES) {
            rat_check(mp_neg(&num, &num));
            rat_check(mp_neg(&den, &den));
        }
        if (mp_iszero(&num) == MP_YES) {
            num.sign = MP_ZPOS;
            mp_set(&den, 1);
            return;
        }
        mp_int abs_num;
        mp_int gcd;
        rat_check(mp_init_copy(&abs_num, &num));
        rat_check(mp_init(&gcd));
        abs_num.sign = MP_ZPOS;
        try {
            rat_check(mp_gcd(&abs_num, &den, &gcd));
            mp_int one;
            rat_check(mp_init_set(&one, 1));
            const bool trivial = mp_cmp(&gcd, &one) == MP_EQ;
            mp_clear(&one);
            if (!trivial) {
                mp_int quotient;
                rat_check(mp_init(&quotient));
                rat_check(mp_div(&num, &gcd, &quotient, nullptr));
                rat_check(mp_copy(&quotient, &num));
                rat_check(mp_div(&den, &gcd, &quotient, nullptr));
                rat_check(mp_copy(&quotient, &den));
                mp_clear(&quotient);
            }
        } catch (...) {
            mp_clear(&abs_num);
            mp_clear(&gcd);
            throw;
        }
        mp_clear(&abs_num);
        mp_clear(&gcd);
    }
};

}  // namespace triwild

#endif
