import { MemoryPersistence } from '../../src/adapters/persistence/memory-persistence.js';
import { persistenceContract } from '../contract/persistence-contract.js';

persistenceContract('memoria', () => Promise.resolve(new MemoryPersistence()));
