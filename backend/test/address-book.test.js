/**
 * Address book. No live Mongo.
 * Run: cd backend && npm install && node --test test/
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import User, { AddressBookError, MAX_ADDRESSES } from '../db/models/User.js';

function addr(street, extra = {}) {
  return {
    name: 'Ada Lovelace',
    street,
    street2: '',
    city: 'Austin',
    state: 'TX',
    zip: '78701',
    country: 'US',
    phone: '5125550100',
    ...extra,
  };
}

function book(email = 'addr@example.com') {
  return new User({ email });
}

describe('User.upsertAddress', () => {
  test('the first address is the default, and a later one does not replace it', () => {
    const user = book();
    const first = user.upsertAddress(addr('1 Old St'), false);
    const second = user.upsertAddress(addr('2 New St'), false);
    assert.equal(user.addresses.length, 2);
    assert.equal(first.isDefault, true);
    assert.equal(second.isDefault, false);
    assert.equal(first.state, 'TX');
  });

  test('makeDefault moves the flag, and a payload isDefault does not clear it', () => {
    const user = book();
    const first = user.upsertAddress(addr('1 Old St'), true);
    const second = user.upsertAddress({ ...addr('2 New St'), isDefault: false }, true);
    assert.equal(first.isDefault, false);
    assert.equal(second.isDefault, true);
  });

  test('the same street, street2, and zip updates that entry in any case', () => {
    const user = book();
    const first = user.upsertAddress(addr('10 Main St', { name: 'Ada', street2: 'Apt 2' }), true);
    const again = user.upsertAddress(addr('  10 MAIN ST ', {
      name: 'Ada Updated',
      street2: ' apt 2 ',
      zip: '78701',
      city: 'Dallas',
    }), false);
    assert.equal(user.addresses.length, 1);
    assert.equal(again._id.equals(first._id), true);
    assert.equal(again.name, 'Ada Updated');
    assert.equal(again.city, 'Dallas');
    assert.equal(again.isDefault, true);
  });

  test('a different apartment or zip appends', () => {
    const user = book();
    user.upsertAddress(addr('10 Main St', { street2: 'Apt 1' }), true);
    user.upsertAddress(addr('10 Main St', { street2: 'Apt 2' }), false);
    user.upsertAddress(addr('10 Main St', { street2: 'Apt 2', zip: '78702' }), false);
    assert.equal(user.addresses.length, 3);
  });

  test('an _id updates that row, including onto another row\'s street', () => {
    const user = book();
    const home = user.upsertAddress(addr('1 Home St'), true);
    user.upsertAddress(addr('2 Work St'), false);
    const saved = user.upsertAddress({ ...addr('2 Work St'), _id: home._id, name: 'Edited' }, false);
    assert.equal(user.addresses.length, 2);
    assert.equal(saved._id.equals(home._id), true);
    assert.equal(saved.name, 'Edited');
    assert.equal(saved.street, '2 Work St');
    assert.equal(home.isDefault, true);
  });

  test('an unknown _id does not append', () => {
    const user = book();
    user.upsertAddress(addr('1 Home St'), true);
    assert.throws(
      () => user.upsertAddress({ ...addr('9 Missing St'), _id: '507f1f77bcf86cd799439011' }, true),
      (error) => error instanceof AddressBookError && error.statusCode === 404,
    );
    assert.equal(user.addresses.length, 1);
    assert.equal(user.addresses[0].isDefault, true);
  });

  test('the 11th distinct address is refused and the book is unchanged', () => {
    const user = book();
    for (let i = 0; i < MAX_ADDRESSES; i += 1) {
      user.upsertAddress(addr(`${i} Cap St`), i === 1);
    }
    assert.equal(user.addresses.length, MAX_ADDRESSES);
    assert.equal(user.addresses[1].isDefault, true);
    assert.throws(
      () => user.upsertAddress(addr('11 Cap St'), true),
      (error) => error instanceof AddressBookError && error.statusCode === 400,
    );
    assert.equal(user.addresses.length, MAX_ADDRESSES);
    assert.equal(user.addresses[1].isDefault, true);
    assert.equal(user.addresses[0].isDefault, false);

    const updated = user.upsertAddress({
      ...addr('0 Cap St'),
      _id: user.addresses[0]._id,
      name: 'Still here',
    }, false);
    assert.equal(updated.name, 'Still here');
    assert.equal(user.addresses.length, MAX_ADDRESSES);

    const deduped = user.upsertAddress(addr('0 cap st', { name: 'Deduped' }), false);
    assert.equal(deduped.name, 'Deduped');
    assert.equal(user.addresses.length, MAX_ADDRESSES);
  });

  test('ten addresses still validate', async () => {
    const user = book('valid-book@example.com');
    for (let i = 0; i < MAX_ADDRESSES; i += 1) {
      user.upsertAddress(addr(`${i} Valid St`), false);
    }
    await user.validate();
    assert.equal(user.addresses.length, MAX_ADDRESSES);
  });
});

describe('User.deleteAddress', () => {
  test('deleting the default promotes the newest remaining address', () => {
    const user = book('delete@example.com');
    const oldest = user.upsertAddress(addr('1 Old St'), true);
    const mid = user.upsertAddress(addr('2 Mid St'), false);
    const newest = user.upsertAddress(addr('3 New St'), false);
    user.deleteAddress(oldest._id);
    assert.equal(user.addresses.length, 2);
    assert.equal(mid.isDefault, false);
    assert.equal(newest.isDefault, true);
  });

  test('newest is the greatest _id when that row is not last', () => {
    const user = book('reorder@example.com');
    const oldest = user.upsertAddress(addr('1 Old St'), true);
    const mid = user.upsertAddress(addr('2 Mid St'), false);
    const newest = user.upsertAddress(addr('3 New St'), false);
    user.set('addresses', [
      newest.toObject(),
      oldest.toObject(),
      mid.toObject(),
    ]);
    user.deleteAddress(String(oldest._id));
    const leftNewest = user.addresses.find((row) => String(row._id) === String(newest._id));
    const leftMid = user.addresses.find((row) => String(row._id) === String(mid._id));
    assert.equal(user.addresses.length, 2);
    assert.equal(leftNewest.isDefault, true);
    assert.equal(leftMid.isDefault, false);
    assert.equal(user.addresses[user.addresses.length - 1].isDefault, false);
  });

  test('deleting a non-default leaves the default alone', () => {
    const user = book('keep@example.com');
    const home = user.upsertAddress(addr('1 Home St'), true);
    const work = user.upsertAddress(addr('2 Work St'), false);
    user.deleteAddress(work._id);
    assert.equal(user.addresses.length, 1);
    assert.equal(home.isDefault, true);
  });

  test('deleting the last address leaves an empty book', () => {
    const user = book('empty@example.com');
    const only = user.upsertAddress(addr('1 Only St'), false);
    user.deleteAddress(only._id);
    assert.equal(user.addresses.length, 0);
  });

  test('a missing id is 404 and does not change the book', () => {
    const user = book('missing@example.com');
    const home = user.upsertAddress(addr('1 Home St'), true);
    assert.throws(
      () => user.deleteAddress('not-an-id'),
      (error) => error instanceof AddressBookError && error.statusCode === 404,
    );
    assert.equal(user.addresses.length, 1);
    assert.equal(home.isDefault, true);
  });
});
