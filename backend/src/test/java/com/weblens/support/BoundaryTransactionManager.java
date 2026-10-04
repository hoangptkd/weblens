package com.weblens.support;

import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.TransactionSystemException;
import org.springframework.transaction.support.AbstractPlatformTransactionManager;
import org.springframework.transaction.support.DefaultTransactionStatus;
import org.springframework.transaction.support.TransactionSynchronizationManager;

/** Exercises Spring's real transaction interceptor without claiming database validation. */
public class BoundaryTransactionManager extends AbstractPlatformTransactionManager {
    public int commits;
    public int rollbacks;
    public boolean failCommit;

    @Override
    protected Object doGetTransaction() { return new Object(); }

    @Override
    protected boolean isExistingTransaction(Object transaction) {
        return TransactionSynchronizationManager.isActualTransactionActive();
    }

    @Override
    protected void doBegin(Object transaction, TransactionDefinition definition) { }

    @Override
    protected void doCommit(DefaultTransactionStatus status) {
        if (failCommit) throw new TransactionSystemException("Test commit failure");
        commits++;
    }

    @Override
    protected void doRollback(DefaultTransactionStatus status) { rollbacks++; }
}
